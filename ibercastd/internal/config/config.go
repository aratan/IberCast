// Package config provides CLI flag parsing and validated defaults for ibercastd.
package config

import (
	"flag"
	"fmt"
	"os"
)

// Config holds the runtime configuration for ibercastd.
type Config struct {
	Port       int
	DataDir    string
	FFmpegPath string
}

// Parse reads CLI flags and returns a validated Config.
// Expects os.Args[1:] to start with "serve" followed by flags.
func Parse() (*Config, error) {
	// Define flags on a new FlagSet so "serve" subcommand doesn't interfere.
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	port := fs.Int("port", 8585, "HTTP server port")
	dataDir := fs.String("data-dir", "./data", "Directory for persistent JSON storage")
	ffmpeg := fs.String("ffmpeg-path", "ffmpeg", "Path to ffmpeg binary")

	// os.Args[0] = binary, [1] = "serve", [2:] = flags
	if err := fs.Parse(os.Args[2:]); err != nil {
		return nil, fmt.Errorf("parse flags: %w", err)
	}

	cfg := &Config{
		Port:       *port,
		DataDir:    *dataDir,
		FFmpegPath: *ffmpeg,
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
	// Ensure data directory exists
	if err := os.MkdirAll(c.DataDir, 0o755); err != nil {
		return fmt.Errorf("cannot create data dir %s: %w", c.DataDir, err)
	}
	return nil
}
