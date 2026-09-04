// Package ingest runs ffmpeg to convert video files to HLS.
package ingest

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

const ffmpegTimeout = 300 * time.Second

// RunFFmpeg converts an input video file to HLS in outputDir.
// It validates the input exists, spawns ffmpeg, and cleans up on return.
func RunFFmpeg(ffmpegPath, inputPath, outputDir string) (manifestPath string, err error) {
	// Validate input exists
	if _, err := os.Stat(inputPath); err != nil {
		return "", fmt.Errorf("input file not found: %w", err)
	}

	// Create output dir
	hlsDir := filepath.Join(outputDir, "hls")
	if err := os.MkdirAll(filepath.Join(hlsDir, "v0"), 0o755); err != nil {
		return "", fmt.Errorf("create hls dir: %w", err)
	}

	// Clean temp dir on return
	defer func() {
		// Keep the HLS output — only clean uploads
		uploadDir := filepath.Join(outputDir, "uploads")
		os.RemoveAll(uploadDir)
	}()

	ctx, cancel := context.WithTimeout(context.Background(), ffmpegTimeout)
	defer cancel()

	manifestPath = filepath.Join(hlsDir, "master.m3u8")

	cmd := exec.CommandContext(ctx, ffmpegPath,
		"-y", "-i", inputPath,
		"-c:v", "libx264", "-preset", "fast", "-pix_fmt", "yuv420p",
		"-c:a", "aac", "-b:a", "128k",
		"-hls_time", "6",
		"-hls_segment_type", "mpegts",
		"-hls_playlist_type", "vod",
		"-hls_segment_filename", filepath.Join(hlsDir, "v0", "seg-%03d.ts"),
		"-f", "hls",
		filepath.Join(hlsDir, "index.m3u8"),
	)

	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("ffmpeg failed: %w", err)
	}

	// Rename index.m3u8 → master.m3u8 (matches publish.mjs convention)
	idx := filepath.Join(hlsDir, "index.m3u8")
	if _, err := os.Stat(idx); err == nil {
		os.Rename(idx, manifestPath)
	}

	return manifestPath, nil
}
