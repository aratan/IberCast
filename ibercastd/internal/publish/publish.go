// Package publish orchestrates the full upload pipeline:
// video file → ffmpeg multi-quality HLS → IPFS add+pin → {CID, HLS URL, duration, qualities}.
package publish

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/victorarbiol/ibercastd/internal/ingest"
	"github.com/victorarbiol/ibercastd/internal/ipfsapi"
)

// Result holds the output of a successful publish.
type Result struct {
	CID       string  `json:"cid"`
	HLSUrl    string  `json:"hlsUrl"`
	Duration  float64 `json:"duration"`
	Qualities []QualityInfo `json:"qualities"`
}

// QualityInfo describes a single HLS quality level.
type QualityInfo struct {
	Name      string  `json:"name"`
	Label     string  `json:"label"`
	Bitrate   string  `json:"bitrate"`
	Duration  float64 `json:"duration"`
}

// Run executes the full pipeline: ingest → IPFS add → CAR export (backup).
// For live streaming, provide a non-nil LiveConfig.
func Run(ffmpegPath, inputPath, dataDir, ipfsEndpoint string, liveCfg *ingest.LiveConfig) (*Result, error) {
	// Validate input
	if _, err := os.Stat(inputPath); err != nil {
		return nil, fmt.Errorf("input file: %w", err)
	}

	// Create work directory
	workDir := filepath.Join(dataDir, "work", fmt.Sprintf("publish-%d", os.Getpid()))
	os.MkdirAll(workDir, 0o755)
	// Keep work dir for CAR files — clean up uploads only
	defer func() {
		uploadDir := filepath.Join(workDir, "uploads")
		os.RemoveAll(uploadDir)
	}()

	// Step 1: ffmpeg → multi-quality HLS (live or vod)
	manifestPath, err := ingest.RunFFmpeg(ffmpegPath, inputPath, workDir, liveCfg)
	if err != nil {
		return nil, fmt.Errorf("ingest: %w", err)
	}

	// Get the HLS output directory (parent of manifest)
	hlsDir := filepath.Dir(manifestPath)

	// Step 2: IPFS add + pin
	client := &ipfsapi.Client{Endpoint: ipfsEndpoint}
	cid, err := client.Add(hlsDir)
	if err != nil {
		return nil, fmt.Errorf("ipfs add: %w", err)
	}

	// Step 3: Export CAR as backup (optional, best-effort)
	carPath := filepath.Join(dataDir, "cars", fmt.Sprintf("%s.car", cid))
	if err := os.MkdirAll(filepath.Dir(carPath), 0o755); err == nil {
		if carErr := client.ExportCAR(cid, carPath); carErr != nil {
			// Log but don't fail — CAR is backup, not critical
			fmt.Fprintf(os.Stderr, "warning: CAR export failed: %v\n", carErr)
		} else {
			fmt.Fprintf(os.Stderr, "CAR exported: %s\n", carPath)
		}
	}

	// Build HLS URL from CID
	hlsUrl := fmt.Sprintf("/ipfs/%s/master.m3u8", cid)

	// Parse duration from each quality level
	duration := estimateDuration(hlsDir)

	// Build quality info
	var qualities []ingest.Quality
	qualities = ingest.DefaultQualities
	qualityInfo := make([]QualityInfo, len(qualities))
	for i, q := range qualities {
		qualityInfo[i] = QualityInfo{
			Name:     q.Name,
			Label:    q.Label,
			Bitrate:  q.VideoBitrate,
			Duration: estimateQualityDuration(hlsDir, q.Name),
		}
	}

	return &Result{
		CID:       cid,
		HLSUrl:    hlsUrl,
		Duration:  duration,
		Qualities: qualityInfo,
	}, nil
}

// estimateDuration counts segments × 6s (hls_time=6) as a rough duration estimate.
// Uses the highest quality (v0) for the estimate.
func estimateDuration(hlsDir string) float64 {
	return estimateQualityDuration(hlsDir, "v0")
}

// estimateQualityDuration counts segments in a specific quality dir.
func estimateQualityDuration(hlsDir, quality string) float64 {
	entries, err := os.ReadDir(filepath.Join(hlsDir, quality))
	if err != nil {
		return 0
	}
	segCount := 0
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".ts") {
			segCount++
		}
	}
	return float64(segCount) * 6.0
}
