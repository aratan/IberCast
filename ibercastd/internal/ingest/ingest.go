// Package ingest runs ffmpeg to convert video files to HLS.
package ingest

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const ffmpegTimeout = 300 * time.Second

// AllowedInputExtensions is the upload extension whitelist from the design.
// Everything else is rejected before ffmpeg ever runs.
var AllowedInputExtensions = map[string]bool{
	".mp4":  true,
	".webm": true,
	".avi":  true,
	".mov":  true,
}

// ValidateExtension checks that filename's extension is in the whitelist.
func ValidateExtension(filename string) error {
	ext := strings.ToLower(filepath.Ext(filename))
	if !AllowedInputExtensions[ext] {
		return fmt.Errorf("unsupported file extension %q (allowed: .mp4, .webm, .avi, .mov)", ext)
	}
	return nil
}

// ValidateInput checks that a file exists on disk and has an allowed extension.
// It runs before any subprocess is spawned, so a malicious or unsupported
// filename never reaches ffmpeg.
func ValidateInput(filePath string) error {
	if err := ValidateExtension(filePath); err != nil {
		return err
	}
	if _, err := os.Stat(filePath); err != nil {
		return fmt.Errorf("input file not found: %w", err)
	}
	return nil
}

// Quality represents an HLS output quality level.
type Quality struct {
	Name       string // e.g. "v0", "v1", "v2"
	Label      string // e.g. "1080p", "720p", "480p"
	VideoBitrate string // e.g. "4000k"
	Width      int    // target width for scaling (0 = no scaling)
}

// DefaultQualities defines the standard 3-quality ladder.
var DefaultQualities = []Quality{
	{Name: "v0", Label: "1080p", VideoBitrate: "4000k", Width: 1920},
	{Name: "v1", Label: "720p",  VideoBitrate: "2500k", Width: 1280},
	{Name: "v2", Label: "480p",  VideoBitrate: "1200k", Width: 854},
}

// LiveConfig configures live HLS streaming parameters.
type LiveConfig struct {
	SegmentTime   int    // segment duration in seconds (4-6 for low-latency)
	PlaylistType  string // "event" for live streaming (allows appending)
	TargetDuration int   // target duration for playlist updates
}

// DefaultLiveConfig returns a sensible default for low-latency live streaming.
var DefaultLiveConfig = LiveConfig{
	SegmentTime:   4,
	PlaylistType:  "event",
	TargetDuration: 6,
}

// RunFFmpeg converts an input video file to multi-quality HLS in outputDir.
// It validates the input exists, spawns ffmpeg for each quality, and cleans up on return.
// Set liveConfig to non-nil for live streaming mode (discontinuous, appendable).
func RunFFmpeg(ffmpegPath, inputPath, outputDir string, liveConfig *LiveConfig) (manifestPath string, err error) {
	// Validate input before spawning any subprocess (extension whitelist + existence)
	if err := ValidateInput(inputPath); err != nil {
		return "", err
	}

	// Create output dir
	hlsDir := filepath.Join(outputDir, "hls")
	if err := os.MkdirAll(hlsDir, 0o755); err != nil {
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

	// Determine if this is a live stream
	isLive := liveConfig != nil
	segTime := 6
	playListType := "vod"
	targetDur := 6
	if isLive {
		segTime = liveConfig.SegmentTime
		playListType = liveConfig.PlaylistType
		targetDur = liveConfig.TargetDuration
	}

	// Generate master playlist header
	masterLines := []string{
		"#EXTM3U",
		"#EXT-X-VERSION:3",
	}
	if isLive {
		masterLines = append(masterLines, "#EXT-X-ALLOW-CACHE:NO")
	}
	masterLines = append(masterLines,
		"#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080",
		"v0/index.m3u8",
		"#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720",
		"v1/index.m3u8",
		"#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=854x480",
		"v2/index.m3u8",
	)

	for _, q := range DefaultQualities {
		qualityDir := filepath.Join(hlsDir, q.Name)
		if err := os.MkdirAll(qualityDir, 0o755); err != nil {
			return "", fmt.Errorf("create quality dir %s: %w", q.Name, err)
		}

		// Build filter args for scaling
		var filterArgs []string
		if q.Width > 0 {
			filterArgs = append(filterArgs, "-vf", fmt.Sprintf("scale=%d:-2", q.Width))
		}

		segmentFilename := filepath.Join(qualityDir, "seg-%03d.ts")
		outputPlaylist := filepath.Join(qualityDir, "index.m3u8")

		cmdArgs := []string{
			"-y", "-i", inputPath,
			"-c:v", "libx264", "-preset", "fast", "-pix_fmt", "yuv420p",
			"-c:a", "aac", "-b:a", "128k",
			"-b:v", q.VideoBitrate,
			"-hls_time", fmt.Sprintf("%d", segTime),
			"-hls_segment_type", "mpegts",
			"-hls_playlist_type", playListType,
			"-hls_segment_filename", segmentFilename,
			"-f", "hls",
			outputPlaylist,
		}

		cmdArgs = append(cmdArgs, filterArgs...)

		cmd := exec.CommandContext(ctx, ffmpegPath, cmdArgs...)

		// Close stdin to prevent ffmpeg from waiting for input
		cmd.Stdin = nil

		// Only share stdout/stderr from first quality to avoid interleaving
		if q.Name == "v0" {
			cmd.Stdout = os.Stdout
			cmd.Stderr = os.Stderr
		}

		if err := cmd.Run(); err != nil {
			// Check if context was cancelled (timeout)
			if ctx.Err() != nil {
				return "", fmt.Errorf("ffmpeg %s timed out: %w", q.Name, ctx.Err())
			}
			return "", fmt.Errorf("ffmpeg %s failed: %w", q.Name, err)
		}

		// Segment URIs generated by ffmpeg (e.g. seg-000.ts) are relative to
		// the quality dir (v0/) where the playlist lives. HLS resolves them
		// relative to the playlist URL, so they must stay unprefixed. A
		// subdir prefix causes v0/v0/seg-000.ts double-join with both path
		// and subdomain gateways.
	}

	// For live streams, write target duration to each quality playlist
	if isLive {
		for _, q := range DefaultQualities {
			playlistPath := filepath.Join(hlsDir, q.Name, "index.m3u8")
			if err := addTargetDuration(playlistPath, targetDur); err != nil {
				return "", fmt.Errorf("add target duration %s: %w", q.Name, err)
			}
		}
	}

	// Write master playlist
	if err := os.WriteFile(manifestPath, []byte(strings.Join(masterLines, "\n")+"\n"), 0o644); err != nil {
		return "", fmt.Errorf("write master playlist: %w", err)
	}

	return manifestPath, nil
}

// addTargetDuration adds or updates #EXT-X-TARGETDURATION in a playlist.
// Required for live streams to inform players of expected segment duration.
func addTargetDuration(path string, targetDur int) error {
	content, err := os.ReadFile(path)
	if err != nil {
		return err
	}

	lines := strings.Split(string(content), "\n")
	modified := false
	newLines := make([]string, 0, len(lines))

	for _, line := range lines {
		if strings.HasPrefix(line, "#EXT-X-TARGETDURATION") {
			newLines = append(newLines, fmt.Sprintf("#EXT-X-TARGETDURATION:%d", targetDur))
			modified = true
		} else {
			newLines = append(newLines, line)
		}
	}

	if !modified {
		// Insert after #EXTM3U
		newLines = append([]string{fmt.Sprintf("#EXT-X-TARGETDURATION:%d", targetDur)}, newLines...)
	}

	return os.WriteFile(path, []byte(strings.Join(newLines, "\n")), 0o644)
}
