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
	r.HandleFunc("/api/videos/{id}", deleteVideo(deps)).Methods("DELETE")

	r.HandleFunc("/api/parrilla", getParrilla(deps)).Methods("GET")
	r.HandleFunc("/api/parrilla", createParrilla(deps)).Methods("POST")
	r.HandleFunc("/api/parrilla/{id}", updateParrilla(deps)).Methods("PUT")
	r.HandleFunc("/api/parrilla/{id}", deleteParrilla(deps)).Methods("DELETE")

	// Unknown routes → 404 (catch-all NOT registered)
	return r
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// --- Security: reject path traversal ---

func safeID(id string) bool {
	return !strings.Contains(id, "..") && !strings.Contains(id, "/")
}

// --- Health ---

func healthHandler(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// --- Videos ---

func listVideos(deps *ServerDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		videos := deps.Store.LoadVideos()
		writeJSON(w, http.StatusOK, videos)
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

		// Save uploaded file to a temp location
		uploadDir := filepath.Join(deps.DataDir, "uploads")
		os.MkdirAll(uploadDir, 0o755)
		inputPath := filepath.Join(uploadDir, header.Filename)
		out, err := os.Create(inputPath)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "cannot save upload")
			return
		}
		if _, err := io.Copy(out, file); err != nil {
			out.Close()
			writeError(w, http.StatusInternalServerError, "upload write failed")
			return
		}
		out.Close()

		// Run publish pipeline: ffmpeg → HLS → IPFS
		result, err := publish.Run(deps.FFmpegPath, inputPath, deps.DataDir, deps.IPFSEndpoint)
		if err != nil {
			writeError(w, http.StatusInternalServerError, fmt.Sprintf("publish failed: %s", err.Error()))
			return
		}

		video := store.Video{
			ID:       generateID(),
			Title:    title,
			CID:      result.CID,
			HLSUrl:   result.HLSUrl,
			Duration: result.Duration,
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
