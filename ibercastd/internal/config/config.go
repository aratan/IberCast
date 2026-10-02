// Package config provides CLI flag parsing (with env-var fallbacks) and
// validated defaults for ibercastd.
package config

import (
	"flag"
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Config holds the runtime configuration for ibercastd.
type Config struct {
	Port         int    // HTTP server port (env PORT)
	DataDir      string // persistent JSON storage directory (env DATA_DIR)
	FFmpegPath   string // path to the ffmpeg binary (env FFMPEG_PATH)
	KuboURL      string // Kubo RPC API endpoint (env KUBO_URL)
	GatewayURL   string // IPFS gateway URL used to build player URLs (env GATEWAY_URL)
	MaxFileSize  int64  // maximum upload size in bytes (env MAX_FILE_SIZE)
	AdminToken   string // token for admin API authentication (optional)
	EnableAuth   bool   // enable authentication for admin endpoints
}

// Defaults matching the design configuration table.
const (
	DefaultPort        = 8585
	DefaultDataDir     = "./data"
	DefaultKuboURL     = "http://localhost:5001"
	DefaultGatewayURL  = "http://localhost:8080"
	DefaultMaxFileSize = 524288000 // 500MB
	DefaultFFmpegPath  = "ffmpeg"
)

// Parse reads CLI flags and returns a validated Config.
// Expects os.Args[1:] to start with "serve" followed by flags.
// Resolution order per option: explicit CLI flag > environment variable > default.
func Parse() (*Config, error) {
	// Define flags on a new FlagSet so "serve" subcommand doesn't interfere.
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	port := fs.Int("port", DefaultPort, "HTTP server port")
	dataDir := fs.String("data-dir", DefaultDataDir, "Directory for persistent JSON storage")
	ffmpeg := fs.String("ffmpeg-path", DefaultFFmpegPath, "Path to ffmpeg binary")
	kuboURL := fs.String("kubo-url", DefaultKuboURL, "Kubo RPC API endpoint")
	gatewayURL := fs.String("gateway-url", DefaultGatewayURL, "IPFS gateway URL")
	maxFileSize := fs.Int64("max-file-size", DefaultMaxFileSize, "Maximum upload size in bytes")
	adminToken := fs.String("admin-token", os.Getenv("IBERCASTD_ADMIN_TOKEN"), "Admin API auth token (optional)")
	enableAuth := fs.Bool("auth-enabled", false, "Enable authentication (fail-closed unless admin-token or enabled)")

	if err := fs.Parse(os.Args[2:]); err != nil {
		return nil, fmt.Errorf("parse flags: %w", err)
	}

	cfg := &Config{
		Port:        *port,
		DataDir:     *dataDir,
		FFmpegPath:  *ffmpeg,
		KuboURL:     *kuboURL,
		GatewayURL:  *gatewayURL,
		MaxFileSize: *maxFileSize,
		AdminToken:  *adminToken,
		EnableAuth:  *enableAuth || *adminToken != "" || os.Getenv("IBERCAST_AUTH_ENABLED") == "true" || os.Getenv("IBERCAST_AUTH_ENABLED") == "1",
	}

	// Environment overrides apply only when the flag was NOT explicitly set.
	set := map[string]bool{}
	fs.Visit(func(f *flag.Flag) { set[f.Name] = true })

	if !set["port"] {
		if v, ok, err := envInt("PORT"); err != nil {
			return nil, fmt.Errorf("invalid PORT env: %w", err)
		} else if ok {
			cfg.Port = v
		}
	}
	if !set["data-dir"] {
		if v, ok := envStr("DATA_DIR"); ok {
			cfg.DataDir = v
		}
	}
	if !set["ffmpeg-path"] {
		if v, ok := envStr("FFMPEG_PATH"); ok {
			cfg.FFmpegPath = v
		}
	}
	if !set["kubo-url"] {
		if v, ok := envStr("KUBO_URL"); ok {
			cfg.KuboURL = v
		}
	}
	if !set["gateway-url"] {
		if v, ok := envStr("GATEWAY_URL"); ok {
			cfg.GatewayURL = v
		}
	}
	if !set["max-file-size"] {
		if v, ok, err := envInt64("MAX_FILE_SIZE"); err != nil {
			return nil, fmt.Errorf("invalid MAX_FILE_SIZE env: %w", err)
		} else if ok {
			cfg.MaxFileSize = v
		}
	}

	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return cfg, nil
}

// Validate checks that the configuration is usable.
func (c *Config) Validate() error {
	if c.Port < 1 || c.Port > 65535 {
		return fmt.Errorf("invalid port: %d", c.Port)
	}
	if c.MaxFileSize < 1 {
		return fmt.Errorf("invalid max-file-size: %d", c.MaxFileSize)
	}
	if c.DataDir == "" {
		return fmt.Errorf("data dir must not be empty")
	}
	// Ensure data directory exists
	if err := os.MkdirAll(c.DataDir, 0o755); err != nil {
		return fmt.Errorf("cannot create data dir %s: %w", c.DataDir, err)
	}
	return nil
}

func envStr(name string) (string, bool) {
	v := os.Getenv(name)
	return v, v != ""
}

func envInt(name string) (int, bool, error) {
	v, ok := envStr(name)
	if !ok {
		return 0, false, nil
	}
	n, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil {
		return 0, true, err
	}
	return n, true, nil
}

func envInt64(name string) (int64, bool, error) {
	v, ok := envStr(name)
	if !ok {
		return 0, false, nil
	}
	n, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64)
	if err != nil {
		return 0, true, err
	}
	return n, true, nil
}