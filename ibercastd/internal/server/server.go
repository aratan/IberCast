// Package server provides the HTTP REST API for ibercastd.
package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/mux"
	"github.com/victorarbiol/ibercastd/internal/publish"
	"github.com/victorarbiol/ibercastd/internal/store"
)

// Config needed by the server to coordinate upload → ingest → IPFS.
type ServerDeps struct {
	Store       *store.Store
	DataDir     string
	FFmpegPath  string
	IPFSEndpoint string // e.g. "http://localhost:5001"
	EnableAuth  bool   // enable authentication for admin endpoints
	AuthToken   string // admin auth token
	// In-memory live streams (for real-time updates)
	liveStreams []store.LiveStream
	mu          sync.RWMutex
}

// NewRouter builds the mux.Router with all routes.
func NewRouter(deps *ServerDeps) *mux.Router {
	r := mux.NewRouter()

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

	r.HandleFunc("/api/health", healthHandler).Methods("GET")
	r.HandleFunc("/api/videos", listVideos(deps)).Methods("GET")
	r.HandleFunc("/api/videos", uploadVideo(deps)).Methods("POST")
	r.HandleFunc("/api/videos/{id}", getVideo(deps)).Methods("GET")
	r.HandleFunc("/api/videos/{id}", deleteVideo(deps)).Methods("DELETE")

	r.HandleFunc("/api/parrilla", getParrilla(deps)).Methods("GET")
	r.HandleFunc("/api/parrilla", createParrilla(deps)).Methods("POST")
	r.HandleFunc("/api/parrilla/{id}", updateParrilla(deps)).Methods("PUT")
	r.HandleFunc("/api/parrilla/{id}", deleteParrilla(deps)).Methods("DELETE")

	// Live streaming
	r.HandleFunc("/api/live", createLiveStream(deps)).Methods("POST")
	r.HandleFunc("/api/live/{id}", updateLiveStream(deps)).Methods("PUT")
	r.HandleFunc("/api/live/{id}", deleteLiveStream(deps)).Methods("DELETE")
	r.HandleFunc("/api/live", listLiveStreams(deps)).Methods("GET")

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

// requireAuth checks for a valid admin token in the Authorization header.
// Returns 401 if auth is enabled but token is missing/invalid.
func requireAuth(w http.ResponseWriter, r *http.Request, deps *ServerDeps) bool {
	if !deps.EnableAuth {
		return true // auth not enabled, allow
	}

	authHeader := r.Header.Get("Authorization")
	if authHeader == "" || !strings.HasPrefix(authHeader, "Bearer ") {
		writeError(w, http.StatusUnauthorized, "missing or invalid Authorization header")
		return false
	}

	token := strings.TrimPrefix(authHeader, "Bearer ")
	if token != deps.AuthToken {
		writeError(w, http.StatusUnauthorized, "invalid token")
		return false
	}

	return true
}

// authMiddleware wraps handlers that require admin authentication.
func authMiddleware(next http.HandlerFunc, deps *ServerDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !requireAuth(w, r, deps) {
			return
		}
		next(w, r)
	}
}

// --- Health ---

func healthHandler(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// rateLimitMiddleware adds basic rate limiting to prevent abuse.
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
		// Parse multipart (max 2 GB)
		if err := r.ParseMultipartForm(2 << 30); err != nil {
			writeError(w, http.StatusBadRequest, "invalid multipart form")
			return
		}

		title := r.FormValue("title")
		if title == "" {
			title = "Untitled"
		}

		file, header, err := r.FormFile("file")
		if err != nil {
			writeError(w, http.StatusBadRequest, "missing file field")
			return
		}
		defer file.Close()

		// Security: validate filename to prevent path traversal
		if !safeFilename(header.Filename) {
			writeError(w, http.StatusBadRequest, "invalid filename")
			return
		}

		// Security: limit upload size (1GB max for videos)
		if header.Size > 1<<30 {
			writeError(w, http.StatusBadRequest, "file too large (max 1GB)")
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
		written, err := io.Copy(out, io.LimitReader(file, 1<<30))
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
			ID:       generateID(),
			Title:    title,
			CID:      result.CID,
			HLSUrl:   result.HLSUrl,
			Duration: result.Duration,
			Qualities: qInfos,
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
		if deps.Store.DeleteVideo(id) {
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
		slots := deps.Store.ResolveParrilla(channelID, day)
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
		if deps.Store.HasOverlap(slot.ChannelID, slot.DayOfWeek, slot.TimeStart, "") {
			writeError(w, http.StatusConflict, "time slot conflict: overlapping entry exists")
			return
		}
		if err := deps.Store.SaveParrilla(slot); err != nil {
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
		if deps.Store.HasOverlap(slot.ChannelID, slot.DayOfWeek, slot.TimeStart, id) {
			writeError(w, http.StatusConflict, "time slot conflict: overlapping entry exists")
			return
		}
		if deps.Store.UpdateParrilla(id, slot) {
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
		if deps.Store.DeleteParrilla(id) {
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

type LiveUpdateRequest struct {
	CurrentCID string `json:"currentCid,omitempty"`
	HLSUrl     string `json:"hlsUrl,omitempty"`
	Duration   float64 `json:"duration,omitempty"`
}

func listLiveStreams(deps *ServerDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// For now, live streams are stored in memory (could persist to JSON later)
		writeJSON(w, http.StatusOK, deps.liveStreams)
	}
}

func createLiveStream(deps *ServerDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !requireAuth(w, r, deps) {
			return
		}
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

		// Create live stream in store
		stream := store.LiveStream{
			ID:        generateID(),
			ChannelID: req.ChannelID,
			Title:     req.Title,
			Status:    "pending",
			StartedAt: time.Now(),
		}
		deps.Store.SaveLiveStream(stream)
		writeJSON(w, http.StatusCreated, stream)
	}
}

func updateLiveStream(deps *ServerDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !requireAuth(w, r, deps) {
			return
		}
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
		if !requireAuth(w, r, deps) {
			return
		}
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

// Serve starts the HTTP server. Blocks until the server closes.
func Start(addr string, handler http.Handler) error {
	srv := &http.Server{
		Addr:         addr,
		Handler:      handler,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  120 * time.Second,
	}
	return srv.ListenAndServe()
}
