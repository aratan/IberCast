// Package server provides the HTTP REST API for ibercastd.
package server

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/mux"
	"github.com/victorarbiol/ibercastd/internal/ingest"
	"github.com/victorarbiol/ibercastd/internal/publish"
	"github.com/victorarbiol/ibercastd/internal/store"
	"github.com/victorarbiol/ibercastd/internal/auth"
)

// Config needed by the server to coordinate upload → ingest → IPFS.
type ServerDeps struct {
	Store        *store.Store
	DataDir      string
	FFmpegPath   string
	IPFSEndpoint string  // e.g. "http://localhost:5001"
	MaxFileSize  int64  // maximum upload size in bytes (0 = design default)
	EnableAuth   bool   // enable authentication for admin endpoints
	AuthToken    string // admin auth token
	PublicPort   int    // public HTTP port (used to build live HLS URLs)
	MediamtxAPI  string // MediaMTX control API (default http://127.0.0.1:9997)
	MediamtxHLS  string // MediaMTX HLS base (default http://127.0.0.1:8888)
	MediamtxRTMP string // MediaMTX RTMP base (default rtmp://<host>:1935)
	Live         *LiveMonitor
}

// defaultMaxFileSize is the design's 500MB cap, applied when deps.MaxFileSize
// is left at its zero value.
const defaultMaxFileSize = 524288000

// NewRouter builds the mux.Router with all routes.
func NewRouter(deps *ServerDeps) *mux.Router {
	r := mux.NewRouter()

	// Custom 404: JSON body, never leak internal paths.
	r.NotFoundHandler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "not found")
	})
	r.MethodNotAllowedHandler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	})

	// Security middleware: reject any URL containing path traversal
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Check both raw URI and cleaned path for traversal
			rawURI := r.RequestURI
			cleanPath := r.URL.Path
			if strings.Contains(rawURI, "..") || strings.Contains(cleanPath, "..") {
				writeError(w, http.StatusBadRequest, "path traversal rejected")
				return
			}
			next.ServeHTTP(w, r)
		})
	})

	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			setSecurityHeaders(w)
			next.ServeHTTP(w, r)
		})
	})


	r.HandleFunc("/api/health", healthHandler).Methods("GET")
	r.HandleFunc("/api/channels", listChannels(deps)).Methods("GET")
	r.HandleFunc("/api/channels", authMiddleware(createChannel(deps), deps)).Methods("POST")

	// Public (read-only): viewer + player can fetch without a token
	r.HandleFunc("/api/videos", listVideos(deps)).Methods("GET")
	r.HandleFunc("/api/videos/{id}", getVideo(deps)).Methods("GET")
	r.HandleFunc("/api/parrilla", getParrilla(deps)).Methods("GET")
	r.HandleFunc("/api/live", listLiveStreams(deps)).Methods("GET")

	// Live HLS proxy: same-origin access to MediaMTX output (http://127.0.0.1:8888/live/<key>/...)
	// Avoids CORS and keeps a single public port (:8585).
	r.HandleFunc("/api/live/hls/{key}/{file:.*}", liveHLSProxy(deps)).Methods("GET")

	// Admin (write): require auth when configured
	r.HandleFunc("/api/videos", authMiddleware(uploadVideo(deps), deps)).Methods("POST")
	r.HandleFunc("/api/videos/{id}", authMiddleware(deleteVideo(deps), deps)).Methods("DELETE")
	r.HandleFunc("/api/parrilla", authMiddleware(createParrilla(deps), deps)).Methods("POST")
	r.HandleFunc("/api/parrilla/{id}", authMiddleware(updateParrilla(deps), deps)).Methods("PUT")
	r.HandleFunc("/api/parrilla/{id}", authMiddleware(deleteParrilla(deps), deps)).Methods("DELETE")


	// Auth
	r.HandleFunc("/api/auth/login", loginHandler(deps)).Methods("POST")
	r.HandleFunc("/api/auth/logout", logoutHandler(deps)).Methods("POST")
	r.HandleFunc("/api/auth/me", meHandler(deps)).Methods("GET")
	r.HandleFunc("/api/auth/csrf", csrfHandler(deps)).Methods("GET")
	// Users (admin only)
	r.HandleFunc("/api/users", usersListHandler(deps)).Methods("GET")
	r.HandleFunc("/api/users", usersCreateHandler(deps)).Methods("POST")
	r.HandleFunc("/api/users/{id}", usersUpdateHandler(deps)).Methods("PUT")
	r.HandleFunc("/api/users/{id}", usersDeleteHandler(deps)).Methods("DELETE")

	// Live streaming (admin)
	r.HandleFunc("/api/live", createLiveStream(deps)).Methods("POST")
	r.HandleFunc("/api/live/{id}", updateLiveStream(deps)).Methods("PUT")
	r.HandleFunc("/api/live/{id}", deleteLiveStream(deps)).Methods("DELETE")

	// Unknown routes → 404 (catch-all NOT registered)
	return r
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func setSecurityHeaders(w http.ResponseWriter) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("X-XSS-Protection", "0")
	w.Header().Set("Referrer-Policy", "no-referrer")
}

// --- Security: reject path traversal ---

func safeID(id string) bool {
	return !strings.Contains(id, "..") && !strings.Contains(id, "/")
}

// safeFilename validates upload filenames to prevent path traversal.
func safeFilename(filename string) bool {
	// Reject empty, absolute paths, and path traversal attempts
	if filename == "" {
		return false
	}
	if strings.Contains(filename, "..") {
		return false
	}
	if strings.HasPrefix(filename, "/") || strings.HasPrefix(filename, "\\") {
		return false
	}
	// Reject special device files and Windows reserved names
	reserved := []string{"CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"}
	base := filepath.Base(filename)
	for _, reserved := range reserved {
		if strings.EqualFold(base, reserved) {
			return false
		}
	}
	// Reject shell metacharacters
	shellChars := []string{"|", "&", ";", "$", "`", "(", ")", "<", ">", "\n", "\r"}
	for _, c := range shellChars {
		if strings.Contains(filename, c) {
			return false
		}
	}
	return true
}

// --- Auth/session/CSRF helpers (session-based) ---

const (
	sessionCookie = "ibercast_sid"
	csrfHeader    = "X-CSRF-Token"
)

type SessionContext struct {
	UserID   string
	Username string
	Role     string
	CSRF     string
}

func (s *ServerDeps) getSessionFromRequest(r *http.Request) (SessionContext, bool) {
	if !s.EnableAuth {
		return SessionContext{}, false
	}
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return SessionContext{}, false
	}
	sess, ok := s.Store.GetSession(c.Value)
	if !ok {
		return SessionContext{}, false
	}
	if time.Now().After(sess.ExpiresAt) {
		s.Store.DeleteSession(sess.ID)
		return SessionContext{}, false
	}
	s.Store.TouchSession(sess.ID)
	return SessionContext{UserID: sess.UserID, Username: sess.Username, Role: sess.Role, CSRF: sess.CSRF}, true
}

func (s *ServerDeps) requireSession(w http.ResponseWriter, r *http.Request) (SessionContext, bool) {
	sc, ok := s.getSessionFromRequest(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return SessionContext{}, false
	}
	return sc, true
}

func (s *ServerDeps) requireCSRF(w http.ResponseWriter, r *http.Request, sc SessionContext) bool {
	if !s.EnableAuth {
		return true
	}
	token := r.Header.Get(csrfHeader)
	if token == "" || token != sc.CSRF {
		writeError(w, http.StatusForbidden, "csrf token invalid")
		return false
	}
	return true
}

func (s *ServerDeps) requireRole(w http.ResponseWriter, sc SessionContext, roles ...string) bool {
	if !s.EnableAuth {
		return true
	}
	for _, rr := range roles {
		if sc.Role == rr {
			return true
		}
	}
	writeError(w, http.StatusForbidden, "forbidden")
	return false
}

// Legacy token auth middleware kept minimal (not used with sessions) - noop
func authMiddleware(next http.HandlerFunc, deps *ServerDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		next(w, r)
	}
}

// --- Health ---

func healthHandler(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// rateLimitMiddleware adds basic rate limiting to prevent abuse.
// --- Channels ---

func listChannels(deps *ServerDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, deps.Store.Channels())
	}
}

func createChannel(deps *ServerDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var ch store.Channel
		if err := json.NewDecoder(r.Body).Decode(&ch); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		ch.ID = strings.TrimSpace(ch.ID)
		if ch.ID == "" {
			ch.ID = generateID()
		}
		if !safeID(ch.ID) {
			writeError(w, http.StatusBadRequest, "invalid channel id")
			return
		}
		ch.Name = strings.TrimSpace(ch.Name)
		if ch.Name == "" {
			ch.Name = ch.ID
		}
		if err := deps.Store.AddChannel(ch); err != nil {
			writeError(w, http.StatusConflict, err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, ch)
	}
}

// --- Videos ---

func listVideos(deps *ServerDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		videos := deps.Store.LoadVideos()
		writeJSON(w, http.StatusOK, videos)
	}
}

func getVideo(deps *ServerDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := mux.Vars(r)["id"]
		if !safeID(id) {
			writeError(w, http.StatusBadRequest, "invalid id")
			return
		}
		video, found := deps.Store.GetVideo(id)
		if !found {
			writeError(w, http.StatusNotFound, "video not found")
			return
		}
		writeJSON(w, http.StatusOK, video)
	}
}

func uploadVideo(deps *ServerDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		maxSize := deps.MaxFileSize
		if maxSize <= 0 {
			maxSize = defaultMaxFileSize
		}

		// Parse multipart (memory threshold 32MB; larger parts spill to disk)
		if err := r.ParseMultipartForm(32 << 20); err != nil {
			writeError(w, http.StatusBadRequest, "invalid multipart form")
			return
		}

		title := r.FormValue("title")
		if title == "" {
			title = "Untitled"
		}

		// Channel assignment (VOD classification). Empty → "default"; unknown
		// channel IDs are rejected so the wall sections always resolve.
		channelID := strings.TrimSpace(r.FormValue("channelId"))
		if channelID == "" {
			channelID = "default"
		}
		if !safeID(channelID) {
			writeError(w, http.StatusBadRequest, "invalid channelId")
			return
		}
		channelKnown := false
		for _, ch := range deps.Store.Channels() {
			if ch.ID == channelID {
				channelKnown = true
				break
			}
		}
		if !channelKnown {
			writeError(w, http.StatusBadRequest, "unknown channelId")
			return
		}

		file, header, err := r.FormFile("file")
		if err != nil {
			writeError(w, http.StatusBadRequest, "missing file field")
			return
		}
		defer file.Close()

		// Security: validate filename to prevent path traversal and shell chars
		if !safeFilename(header.Filename) {
			writeError(w, http.StatusBadRequest, "invalid filename")
			return
		}

		// Security: extension whitelist (reject before writing anything)
		if err := ingest.ValidateExtension(header.Filename); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}

		// Security: limit upload size
		if header.Size > maxSize {
			writeError(w, http.StatusBadRequest, "file too large")
			return
		}

		// Validate content type from multipart header
		contentType := header.Header.Get("Content-Type")
		if contentType != "" {
			if !strings.HasPrefix(contentType, "video/") && contentType != "application/octet-stream" {
				writeError(w, http.StatusBadRequest, "only video files accepted")
				return
			}
		}

		// Save uploaded file to a temp location with sanitized name
		uploadDir := filepath.Join(deps.DataDir, "uploads")
		os.MkdirAll(uploadDir, 0o755)
		// Sanitize filename: only allow alphanumeric, dash, underscore, dot
		sanitizedName := strings.Map(func(r rune) rune {
			if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.' {
				return r
			}
			return '-'
		}, header.Filename)
		if sanitizedName == "" {
			sanitizedName = "upload"
		}
		inputPath := filepath.Join(uploadDir, sanitizedName)

		// Double-check the final path is within uploads dir
		absUploadDir, _ := filepath.Abs(uploadDir)
		absInputPath, _ := filepath.Abs(inputPath)
		if !strings.HasPrefix(absInputPath, absUploadDir) {
			writeError(w, http.StatusBadRequest, "invalid upload path")
			return
		}

		out, err := os.Create(inputPath)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "cannot save upload")
			return
		}
		defer out.Close()

		// Write with size limit
		written, err := io.Copy(out, io.LimitReader(file, maxSize))
		if err != nil {
			writeError(w, http.StatusInternalServerError, "upload write failed")
			return
		}
		if written == 0 {
			writeError(w, http.StatusBadRequest, "empty file")
			return
		}
		out.Close()

		// Run publish pipeline: ffmpeg → HLS → IPFS (VOD mode)
		result, err := publish.Run(deps.FFmpegPath, inputPath, deps.DataDir, deps.IPFSEndpoint, nil)
		if err != nil {
			writeError(w, http.StatusInternalServerError, fmt.Sprintf("publish failed: %s", err.Error()))
			return
		}

		// Convert publish.QualityInfo to store.QualityInfo
		qInfos := make([]store.QualityInfo, len(result.Qualities))
		for i, q := range result.Qualities {
			qInfos[i] = store.QualityInfo{
				Name:     q.Name,
				Label:    q.Label,
				Bitrate:  q.Bitrate,
				Duration: q.Duration,
			}
		}

		video := store.Video{
			ID:        generateID(),
			Title:     title,
			CID:       result.CID,
			HLSUrl:    result.HLSUrl,
			Duration:  result.Duration,
			ChannelID: channelID,
			Qualities: qInfos,
			// Served from the same IPFS root as the manifest, so the wall can
			// load artwork over the gateway with no extra endpoint.
			ThumbnailURL: fmt.Sprintf("/ipfs/%s/thumb.jpg", result.CID),
		}

		if err := deps.Store.SaveVideo(video); err != nil {
			writeError(w, http.StatusInternalServerError, "save video metadata failed")
			return
		}

		writeJSON(w, http.StatusCreated, video)
	}
}

func deleteVideo(deps *ServerDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := mux.Vars(r)["id"]
		if !safeID(id) {
			writeError(w, http.StatusBadRequest, "invalid id")
			return
		}
		ok := deps.Store.DeleteVideo(id)
		
		if ok {
			w.WriteHeader(http.StatusNoContent)
		} else {
			writeError(w, http.StatusNotFound, "video not found")
		}
	}
}

// --- Parrilla ---

func getParrilla(deps *ServerDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		channelID := r.URL.Query().Get("channelId")
		dayStr := r.URL.Query().Get("day")
		if channelID == "" {
			channelID = "default"
		}
		day := 0
		if dayStr != "" {
			fmt.Sscanf(dayStr, "%d", &day)
		}
		slots := deps.Store.ResolveParrillaFiltered(channelID, day)
		writeJSON(w, http.StatusOK, slots)
	}
}

func createParrilla(deps *ServerDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var slot store.ParrillaSlot
		if err := json.NewDecoder(r.Body).Decode(&slot); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		if slot.ID == "" {
			slot.ID = generateID()
		}
		if deps.Store.HasOverlap2(slot.ChannelID, slot.DayOfWeek, slot.TimeStart, "") {
			writeError(w, http.StatusConflict, "time slot conflict: overlapping entry exists")
			return
		}
		if err := deps.Store.SaveParrillaSlot(slot); err != nil {
			writeError(w, http.StatusInternalServerError, "save failed")
			return
		}
		writeJSON(w, http.StatusCreated, slot)
	}
}

func updateParrilla(deps *ServerDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := mux.Vars(r)["id"]
		if !safeID(id) {
			writeError(w, http.StatusBadRequest, "invalid id")
			return
		}
		var slot store.ParrillaSlot
		if err := json.NewDecoder(r.Body).Decode(&slot); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		slot.ID = id
		if deps.Store.HasOverlap2(slot.ChannelID, slot.DayOfWeek, slot.TimeStart, id) {
			writeError(w, http.StatusConflict, "time slot conflict: overlapping entry exists")
			return
		}
		ok, err := deps.Store.UpdateParrilla(id, slot)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "save failed")
			return
		}
		if ok {
			writeJSON(w, http.StatusOK, slot)
		} else {
			writeError(w, http.StatusNotFound, "slot not found")
		}
	}
}

func deleteParrilla(deps *ServerDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := mux.Vars(r)["id"]
		if !safeID(id) {
			writeError(w, http.StatusBadRequest, "invalid id")
			return
		}
		ok, _ := deps.Store.DeleteParrilla(id)
		if ok {
			w.WriteHeader(http.StatusNoContent)
		} else {
			writeError(w, http.StatusNotFound, "slot not found")
		}
	}
}

// --- Live streaming ---

type LiveRequest struct {
	ChannelID string `json:"channelId"`
	Title     string `json:"title"`
}

// LiveStreamView augments a stored live stream with the URLs the UI needs:
// the RTMP push endpoint (for OBS) and the public HLS playback URL (through
// the same-origin proxy in ibercastd).
type LiveStreamView struct {
	store.LiveStream
	RtmpURL string `json:"rtmpUrl,omitempty"`
	HLSUrl  string `json:"hlsUrl,omitempty"`
}

func (deps *ServerDeps) mediamtxHLSBase() string {
	if deps.MediamtxHLS != "" {
		return strings.TrimSuffix(deps.MediamtxHLS, "/")
	}
	return "http://127.0.0.1:8888"
}

// liveView builds the public view for a stored stream. host comes from the
// request's Host header (e.g. "localhost:8585" or "192.168.1.10:8585"); the
// port is stripped so RTMP/OBS URLs keep the MediaMTX port (:1935).
func liveView(s store.LiveStream, host string, port int) LiveStreamView {
	v := LiveStreamView{LiveStream: s}
	if s.StreamKey == "" {
		return v
	}
	h := host
	if i := strings.IndexByte(h, ':'); i >= 0 {
		h = h[:i]
	}
	if h == "" || h == "[" {
		h = "localhost"
	}
	v.RtmpURL = fmt.Sprintf("rtmp://%s:1935/live/%s", h, s.StreamKey)
	httpPort := port
	if httpPort == 0 {
		httpPort = 8585
	}
	v.HLSUrl = fmt.Sprintf("http://%s:%d/api/live/hls/%s/index.m3u8", h, httpPort, s.StreamKey)
	return v
}

type LiveUpdateRequest struct {
	CurrentCID string `json:"currentCid,omitempty"`
	HLSUrl     string `json:"hlsUrl,omitempty"`
	Duration   float64 `json:"duration,omitempty"`
}

func listLiveStreams(deps *ServerDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Live streams persist in the store (data/live.json), reloaded at boot.
		// Status is kept fresh by the MediaMTX poller; views add RTMP/HLS URLs.
		streams := deps.Store.LoadLiveStreams()
		views := make([]LiveStreamView, 0, len(streams))
		for _, s := range streams {
			views = append(views, liveView(s, r.Host, deps.PublicPort))
		}
		writeJSON(w, http.StatusOK, views)
	}
}

func createLiveStream(deps *ServerDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
				var req LiveRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}

		if req.ChannelID == "" {
			req.ChannelID = "default"
		}
		if req.Title == "" {
			req.Title = "Live Stream"
		}

		key, err := generateStreamKey()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "could not generate stream key")
			return
		}

		// Create live stream in store
		stream := store.LiveStream{
			ID:        generateID(),
			ChannelID: req.ChannelID,
			Title:     req.Title,
			Status:    "pending",
			StartedAt: time.Now(),
			StreamKey: key,
		}
		deps.Store.SaveLiveStream(stream)
		writeJSON(w, http.StatusCreated, liveView(stream, r.Host, deps.PublicPort))
	}
}

func updateLiveStream(deps *ServerDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
				id := mux.Vars(r)["id"]
		if !safeID(id) {
			writeError(w, http.StatusBadRequest, "invalid id")
			return
		}

		var update LiveUpdateRequest
		if err := json.NewDecoder(r.Body).Decode(&update); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}

		stream, found := deps.Store.GetLiveStream(id)
		if !found {
			writeError(w, http.StatusNotFound, "stream not found")
			return
		}

		// Update stream info
		if update.CurrentCID != "" {
			stream.CurrentCID = update.CurrentCID
		}
		if update.HLSUrl != "" {
			stream.HLSUrl = update.HLSUrl
		}
		if update.Duration > 0 {
			stream.Duration = update.Duration
		}
		if stream.Status == "pending" && update.CurrentCID != "" {
			stream.Status = "live"
		}

		deps.Store.UpdateLiveStream(id, stream)
		writeJSON(w, http.StatusOK, stream)
	}
}

func deleteLiveStream(deps *ServerDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
				id := mux.Vars(r)["id"]
		if !safeID(id) {
			writeError(w, http.StatusBadRequest, "invalid id")
			return
		}
		if deps.Store.DeleteLiveStream(id) {
			w.WriteHeader(http.StatusNoContent)
		} else {
			writeError(w, http.StatusNotFound, "stream not found")
		}
	}
}

func generateID() string {
	return fmt.Sprintf("%d", time.Now().UnixNano())
}

// generateStreamKey produces a random RTMP path key (ic_<16 hex>).
func generateStreamKey() (string, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return "ic_" + hex.EncodeToString(b), nil
}

// validStreamKey restricts the HLS proxy to keys we generated ourselves.
func validStreamKey(k string) bool {
	if len(k) != len("ic_")+16 || !strings.HasPrefix(k, "ic_") {
		return false
	}
	_, err := hex.DecodeString(k[3:])
	return err == nil
}

// --- Live liveness monitoring (MediaMTX poller) ---

// LiveMonitor tracks when each stream key went live, so on disconnect the
// poller can compute an accurate duration.
type LiveMonitor struct {
	mu     sync.Mutex
	active map[string]time.Time
}

func (m *LiveMonitor) mark(key string, now time.Time) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.active[key]; !ok {
		m.active[key] = now
	}
}

// since removes key and returns seconds it was live (0 if not tracked).
func (m *LiveMonitor) since(key string, now time.Time) float64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	t, ok := m.active[key]
	if ok {
		delete(m.active, key)
	}
	if !ok {
		return 0
	}
	return now.Sub(t).Seconds()
}

func defaultLiveMonitor() *LiveMonitor {
	return &LiveMonitor{active: make(map[string]time.Time)}
}

// StartLivePoller launches a background goroutine that polls the MediaMTX
// control API and flips stored live streams pending→live→ended.
func StartLivePoller(deps *ServerDeps) {
	if deps.Live == nil {
		deps.Live = defaultLiveMonitor()
	}
	if deps.MediamtxAPI == "" {
		deps.MediamtxAPI = "http://127.0.0.1:9997"
	}
	if deps.MediamtxHLS == "" {
		deps.MediamtxHLS = "http://127.0.0.1:8888"
	}
	ticker := time.NewTicker(5 * time.Second)
	go func() {
		for range ticker.C {
			deps.pollLiveOnce()
		}
	}()
}

func (deps *ServerDeps) pollLiveOnce() {
	resp, err := http.Get(fmt.Sprintf("%s/v3/paths/list", deps.MediamtxAPI))
	if err != nil {
		return // MediaMTX down — leave statuses as-is
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return
	}
	var payload struct {
		Items []struct {
			Name  string `json:"name"`
			Ready bool   `json:"ready"`
		} `json:"items"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return
	}
	ready := make(map[string]bool)
	for _, it := range payload.Items {
		if strings.HasPrefix(it.Name, "live/") {
			ready[strings.TrimPrefix(it.Name, "live/")] = it.Ready
		}
	}
	if len(ready) == 0 {
		// MediaMTX removes a path as soon as the publisher disconnects, so an
		// empty list means every previously-live stream just ended.
		now := time.Now()
		for _, s := range deps.Store.LoadLiveStreams() {
			if s.Status == "live" {
				if secs := deps.Live.since(s.StreamKey, now); secs > 0 {
					s.Duration = math.Round(secs*10) / 10
				}
				s.Status = "ended"
				deps.Store.UpdateLiveStream(s.ID, s)
			}
		}
		return
	}
	now := time.Now()
	for _, s := range deps.Store.LoadLiveStreams() {
		if s.StreamKey == "" {
			continue
		}
		cur, ok := ready[s.StreamKey]
		if !ok {
			continue
		}
		st, found := deps.Store.GetLiveStream(s.ID)
		if !found {
			continue
		}
		if cur {
			deps.Live.mark(s.StreamKey, now)
			if st.Status != "live" {
				st.Status = "live"
				deps.Store.UpdateLiveStream(s.ID, st)
			}
		} else if st.Status == "live" {
			if secs := deps.Live.since(s.StreamKey, now); secs > 0 {
				st.Duration = math.Round(secs*10) / 10
			}
			st.Status = "ended"
			deps.Store.UpdateLiveStream(s.ID, st)
		}
	}
}

// --- Live HLS same-origin proxy ---

// liveHLSProxy forwards /api/live/hls/{key}/{file} to MediaMTX's internal HLS
// server. Keeping it behind ibercastd avoids CORS and exposes one public port.
func liveHLSProxy(deps *ServerDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		vars := mux.Vars(r)
		key := vars["key"]
		file := vars["file"]
		if !validStreamKey(key) {
			writeError(w, http.StatusBadRequest, "invalid stream key")
			return
		}
		base, err := url.Parse(deps.mediamtxHLSBase())
		if err != nil {
			writeError(w, http.StatusInternalServerError, "bad upstream")
			return
		}
		proxy := httputil.NewSingleHostReverseProxy(base)
		// MediaMTX ≥ v1.18 performs an HLS handshake: the first manifest request
		// gets a 302 + cookie ("cookieCheck") and the session id travels as a
		// cookie or query param. Its Location header points at the upstream
		// path (/live/<key>/...) which bypasses our public prefix — rewrite it
		// back to the same-origin proxy path so the browser completes the
		// round trips (Playlist → cookieCheck → session → segments).
		originalPath := r.URL.Path
		proxy.ModifyResponse = func(resp *http.Response) error {
			loc := resp.Header.Get("Location")
			if resp.StatusCode >= 300 && resp.StatusCode < 400 && loc != "" && strings.HasPrefix(loc, "/live/") {
				newLoc := originalPath
				if i := strings.IndexByte(loc, '?'); i >= 0 {
					newLoc += loc[i:]
				}
				resp.Header.Set("Location", newLoc)
			}
			// MediaMTX sends its own CORS headers (ACAO per-Origin + Vary).
			// Combined with the permissive single-`*` wrapper in main.go the
			// browser sees two conflicting ACAO values and rejects the response
			// ("Failed to fetch"). Strip the upstream ones; the wrapper applies
			// its own single header to every response.
			resp.Header.Del("Access-Control-Allow-Origin")
			resp.Header.Del("Access-Control-Allow-Methods")
			resp.Header.Del("Access-Control-Allow-Headers")
			resp.Header.Del("Vary")
			return nil
		}
		// Rewrite to MediaMTX's expected path before the default director runs.
		r.URL.Path = fmt.Sprintf("/live/%s/%s", key, file)
		defer func() { r.URL.Path = originalPath }()
		proxy.ServeHTTP(w, r)
	}
}

// NewServer builds an http.Server with sane timeouts for the given handler.
// WriteTimeout is 300s so large uploads + the ffmpeg ingest window (max 300s)
// are not cut off mid-flight.
func NewServer(addr string, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: 30 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      300 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
}

// Start listens and serves until the server closes (blocking).
func Start(addr string, handler http.Handler) error {
	return NewServer(addr, handler).ListenAndServe()
}

func loginHandler(deps *ServerDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Username string `json:"username"`
			Password string `json:"password"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		u, ok := deps.Store.GetUserByName(body.Username)
		if !ok || !u.Active {
			writeError(w, http.StatusUnauthorized, "invalid credentials")
			return
		}
		if okp, _ := auth.VerifyPassword(body.Password, u.PasswordHash); !okp {
			writeError(w, http.StatusUnauthorized, "invalid credentials")
			return
		}
		deps.Store.CleanupSessions()
		csrf, _ := auth.CSRFToken()
		sid, _ := auth.SessionID()
		exp := auth.SessionExpiry()
		sess := store.Session{
			ID: sid, UserID: u.ID, Username: u.Username, Role: u.Role, CSRF: csrf,
			ExpiresAt: exp, LastSeen: time.Now(), CreatedAt: time.Now(),
		}
		_ = deps.Store.CreateSession(sess)
		http.SetCookie(w, &http.Cookie{
			Name: sessionCookie, Value: sid, Path: "/", HttpOnly: true,
			Expires: exp, SameSite: http.SameSiteLaxMode,
		})
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"user": map[string]string{"id": u.ID, "username": u.Username, "role": u.Role},
			"csrf": csrf,
		})
	}
}
func logoutHandler(deps *ServerDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(sessionCookie)
		if err == nil {
			deps.Store.DeleteSession(c.Value)
			http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true})
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
func meHandler(deps *ServerDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sc, ok := deps.getSessionFromRequest(r)
		if !ok {
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"user": map[string]string{"id": sc.UserID, "username": sc.Username, "role": sc.Role},
			"csrf": sc.CSRF,
		})
	}
}
func csrfHandler(deps *ServerDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sc, ok := deps.getSessionFromRequest(r)
		if !ok {
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"csrf": sc.CSRF})
	}
}
func usersListHandler(deps *ServerDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sc, ok := deps.getSessionFromRequest(r)
		if !ok || sc.Role != "admin" {
			writeError(w, http.StatusForbidden, "forbidden")
			return
		}
		deps.Store.CleanupSessions()
		writeJSON(w, http.StatusOK, deps.Store.ListUsersSanitized())
	}
}
func usersCreateHandler(deps *ServerDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sc, ok := deps.getSessionFromRequest(r)
		if !ok || sc.Role != "admin" {
			writeError(w, http.StatusForbidden, "forbidden")
			return
		}
		var body struct {
			Username string `json:"username"`
			Password string `json:"password"`
			Role     string `json:"role"`
			Active   bool   `json:"active"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		if !auth.ValidUsername(body.Username) {
			writeError(w, http.StatusBadRequest, "invalid username")
			return
		}
		if body.Role != "admin" && body.Role != "uploader" {
			body.Role = "uploader"
		}
		hash, err := auth.HashPassword(body.Password)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "hash failed")
			return
		}
		uid, _ := auth.GenerateID()
		u := store.User{
			ID: uid, Username: body.Username, Role: body.Role, PasswordHash: hash,
			Active: body.Active, CreatedAt: time.Now(), UpdatedAt: time.Now(),
		}
		if err := deps.Store.AddUser(u); err != nil {
			writeError(w, http.StatusConflict, err.Error())
			return
		}
		u.PasswordHash = ""
		writeJSON(w, http.StatusCreated, u)
	}
}
func usersUpdateHandler(deps *ServerDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotImplemented, "auth not fully wired yet")
	}
}
func usersDeleteHandler(deps *ServerDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotImplemented, "auth not fully wired yet")
	}
}
