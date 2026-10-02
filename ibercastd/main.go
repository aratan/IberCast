// ibercastd — IberCast TV station daemon.
//
// Usage:
//
//	ibercastd serve [--port 8585] [--data-dir ./data] [--ffmpeg-path ffmpeg]
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/victorarbiol/ibercastd/internal/config"
	"github.com/victorarbiol/ibercastd/internal/server"
	"github.com/victorarbiol/ibercastd/internal/store"
	"github.com/victorarbiol/ibercastd/internal/auth"
)

func main() {
	if len(os.Args) < 2 || os.Args[1] != "serve" {
		fmt.Fprintln(os.Stderr, "Usage: ibercastd serve [flags]")
		fmt.Fprintln(os.Stderr, "\nFlags:")
		fmt.Fprintln(os.Stderr, "  --port             HTTP port (default 8585)")
		fmt.Fprintln(os.Stderr, "  --data-dir         Persistent storage directory (default ./data)")
		fmt.Fprintln(os.Stderr, "  --ffmpeg-path      Path to ffmpeg binary (default ffmpeg)")
		fmt.Fprintln(os.Stderr, "  --kubo-url         Kubo RPC endpoint (default http://localhost:5001)")
		fmt.Fprintln(os.Stderr, "  --gateway-url      IPFS gateway URL (default http://localhost:8080)")
		fmt.Fprintln(os.Stderr, "  --max-file-size    Max upload size in bytes (default 524288000)")
		fmt.Fprintln(os.Stderr, "  --admin-token      Admin API auth token (optional)")
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

	// Bootstrap admin if no users exist
	users := s.ListUsersSanitized()
	if len(users) == 0 {
		if cfg.EnableAuth {
			pass, err := auth.GenerateID()
			if err != nil {
				pass, _ = auth.SessionID()
			}
		hash, err := auth.HashPassword(pass)
		if err != nil {
				log.Fatalf("admin bootstrap hash: %%v", err)
			}
		uid, _ := auth.GenerateID()
		u := store.User{
			ID: uid, Username: "admin", Role: "admin", PasswordHash: hash,
			Active: true, ForcePasswordChange: true, CreatedAt: time.Now(), UpdatedAt: time.Now(),
		}
		if err := s.AddUser(u); err != nil {
				log.Fatalf("admin bootstrap: %%v", err)
			}
		fmt.Fprintf(os.Stdout, "ibercastd: created initial admin\nusername: admin\npassword: %%s\n", pass)
		} else {
		fmt.Fprintf(os.Stdout, "ibercastd: auth disabled, no admin created\n")
		}
	}

	addr := fmt.Sprintf(":%d", cfg.Port)
	deps := &server.ServerDeps{
		Store:        s,
		DataDir:      cfg.DataDir,
		FFmpegPath:   cfg.FFmpegPath,
		IPFSEndpoint: cfg.KuboURL,
		MaxFileSize:  cfg.MaxFileSize,
		EnableAuth:   cfg.EnableAuth,
		AuthToken:    cfg.AdminToken,
		PublicPort:   cfg.Port,
		Live:         nil, // StartLivePoller lazily creates a monitor
	}

	// Live streaming: poll MediaMTX so pending→live→ended transitions happen
	// automatically while OBS pushes (or stops pushing) RTMP.
	server.StartLivePoller(deps)

	router := server.NewRouter(deps)

	// Security wrapper: reject path traversal BEFORE gorilla/mux processes the request.
	// Go's HTTP server normalizes paths, so `..` in a URL gets cleaned before the handler.
	// This wrapper catches the raw request URI. Also adds permissive CORS so the
	// browser player (dev server or IPFS gateway) can call the API cross-origin.
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.RequestURI, "..") || strings.Contains(r.URL.Path, "..") {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{"error": "path traversal rejected"})
			return
		}
		// CORS: allow any origin for API calls from the browser player.
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		// Echo the requested headers (the dashboard sends Authorization for admin ops).
		allowHdrs := r.Header.Get("Access-Control-Request-Headers")
		if allowHdrs == "" {
			allowHdrs = "Content-Type"
		}
		w.Header().Set("Access-Control-Allow-Headers", allowHdrs)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		router.ServeHTTP(w, r)
	})

	srv := server.NewServer(addr, handler)

	// Start listening in background
	errCh := make(chan error, 1)
	go func() {
		log.Printf("ibercastd listening on %s (data: %s, kubo: %s)", addr, cfg.DataDir, cfg.KuboURL)
		errCh <- srv.ListenAndServe()
	}()

	// Wait for SIGINT / SIGTERM or server failure
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	select {
	case sig := <-quit:
		log.Printf("received %s, shutting down...", sig)
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := srv.Shutdown(ctx); err != nil {
			log.Printf("graceful shutdown: %v", err)
		}
		log.Println("shutdown complete")
	case err := <-errCh:
		if err != nil && err != http.ErrServerClosed {
			log.Fatalf("server: %v", err)
		}
	}
}
