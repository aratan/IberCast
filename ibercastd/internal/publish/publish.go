// Package publish orchestrates the full upload pipeline:
// video file → ffmpeg HLS → IPFS add+pin → {CID, HLS URL, duration}.
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
	CID      string  `json:"cid"`
	HLSUrl   string  `json:"hlsUrl"`
	Duration float64 `json:"duration"`
}

// Run executes the full pipeline: ingest → IPFS add.
func Run(ffmpegPath, inputPath, dataDir, ipfsEndpoint string) (*Result, error) {
	// Validate input
	if _, err := os.Stat(inputPath); err != nil {
		return nil, fmt.Errorf("input file: %w", err)
	}

	// Create work directory
	workDir := filepath.Join(dataDir, "work", fmt.Sprintf("publish-%d", os.Getpid()))
	os.MkdirAll(workDir, 0o755)
	defer os.RemoveAll(workDir)

	// Step 1: ffmpeg → HLS
	manifestPath, err := ingest.RunFFmpeg(ffmpegPath, inputPath, workDir)
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

	// Build HLS URL from CID
	hlsUrl := fmt.Sprintf("/ipfs/%s/master.m3u8", cid)

	// Parse duration from the filename pattern (fallback to 0)
	duration := estimateDuration(hlsDir)

	return &Result{
		CID:      cid,
		HLSUrl:   hlsUrl,
		Duration: duration,
	}, nil
}

// estimateDuration counts segments × 6s (hls_time=6) as a rough duration estimate.
func estimateDuration(hlsDir string) float64 {
	entries, err := os.ReadDir(filepath.Join(hlsDir, "v0"))
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
