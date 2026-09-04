// Package ingest runs ffmpeg to convert video files to HLS.
package ingest

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const ffmpegTimeout = 300 * time.Second

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
	// Validate input exists
	if _, err := os.Stat(inputPath); err != nil {
		return "", fmt.Errorf("input file not found: %w", err)
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

		// Normalize relative segment URIs in quality playlist
		if err := rebaseManifest(outputPlaylist, q.Name); err != nil {
			return "", fmt.Errorf("rebase manifest %s: %w", q.Name, err)
		}
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

// rebaseManifest prefixes every segment URI line in an m3u8 with the given
// subdir, unless the line already contains a slash (absolute or prefixed).
// Comment (#…) and blank lines are left untouched.
func rebaseManifest(path, subdir string) error {
	in, err := os.Open(path)
	if err != nil {
		return err
	}
	defer in.Close()

	var lines []string
	sc := bufio.NewScanner(in)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line != "" && !strings.HasPrefix(line, "#") && !strings.Contains(line, "/") {
			line = subdir + "/" + line
		}
		lines = append(lines, line)
	}
	if err := sc.Err(); err != nil {
		return err
	}

	// Atomic-ish rewrite.
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
