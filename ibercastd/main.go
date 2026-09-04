// ibercastd — IberCast TV station daemon.
//
// Usage:
//
//	ibercastd serve [--port 8585] [--data-dir ./data] [--ffmpeg-path ffmpeg]
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/victorarbiol/ibercastd/internal/config"
	"github.com/victorarbiol/ibercastd/internal/server"
	"github.com/victorarbiol/ibercastd/internal/store"
)

func main() {
	if len(os.Args) < 2 || os.Args[1] != "serve" {
		fmt.Fprintln(os.Stderr, "Usage: ibercastd serve [flags]")
		fmt.Fprintln(os.Stderr, "\nFlags:")
		fmt.Fprintln(os.Stderr, "  --port         HTTP port (default 8585)")
		fmt.Fprintln(os.Stderr, "  --data-dir     Persistent storage directory (default ./data)")
		fmt.Fprintln(os.Stderr, "  --ffmpeg-path  Path to ffmpeg binary (default ffmpeg)")
		os.Exit(1)
	}

	cfg, err := config.Parse()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	s, err := store.New(cfg.DataDir)
	if err != nil {
		log.Fatalf("store: %v", err)
	}

	addr := fmt.Sprintf(":%d", cfg.Port)
	deps := &server.ServerDeps{
		Store:        s,
		DataDir:      cfg.DataDir,
		FFmpegPath:   cfg.FFmpegPath,
		IPFSEndpoint: "http://localhost:5001",
	}

	router := server.NewRouter(deps)

	// Security wrapper: reject path traversal BEFORE gorilla/mux processes the request.
	// Go's HTTP server normalizes paths, so `..` in a URL gets cleaned before the handler.
	// This wrapper catches the raw request URI.
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.RequestURI, "..") || strings.Contains(r.URL.Path, "..") {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{"error": "path traversal rejected"})
			return
		}
		router.ServeHTTP(w, r)
	})

	// Start listening
	go func() {
		log.Printf("ibercastd listening on %s (data: %s)", addr, cfg.DataDir)
		if err := server.Start(addr, handler); err != nil {
			log.Fatalf("server: %v", err)
		}
	}()

	// Wait for SIGINT
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	log.Println("shutting down...")
}
