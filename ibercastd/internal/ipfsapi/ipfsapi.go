// Package ipfsapi provides a minimal Kubo RPC client for add + pin.
package ipfsapi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// Client talks to the Kubo RPC API on localhost:5001.
type Client struct {
	Endpoint string // e.g. "http://localhost:5001"
}

// AddResult is the JSON response from /api/v0/add (one line per added file,
// plus a final line for the wrapped directory when wrap=true).
type AddResult struct {
	Name string `json:"Name"`
	Hash string `json:"Hash"`
	Size string `json:"Size"`
}

// CARExportResult is the response from /api/v0/dag/export.
type CARExportResult struct {
	Size   int    `json:"Size"`
	Blocks int    `json:"Blocks"`
	Data   string `json:"data"` // base64-encoded or path reference depending on API version
}

// Add uploads a directory tree to IPFS as a single wrapped directory and
// returns the root CID. Every file and nested subdirectory becomes a link of
// the root, so paths like dir/master.m3u8 and dir/v0/seg-000.ts resolve.
func (c *Client) Add(dirPath string) (string, error) {
	endpoint := c.Endpoint
	if endpoint == "" {
		endpoint = "http://localhost:5001"
	}

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := addTree(writer, dirPath, ""); err != nil {
		return "", fmt.Errorf("collect files: %w", err)
	}
	if err := writer.Close(); err != nil {
		return "", fmt.Errorf("close writer: %w", err)
	}

	url := fmt.Sprintf("%s/api/v0/add?pin=true&wrap-with-directory=true", endpoint)
	req, err := newRequest("POST", url, &body)
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())

	resp, err := doRequest(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	// Response is a stream of JSON objects (one per file) followed by the
	// wrapped directory object. We accumulate and return the wrapped root CID.
	dec := json.NewDecoder(resp.Body)
	var rootCID string
	var last AddResult
	for dec.More() {
		var r AddResult
		if err := dec.Decode(&r); err != nil {
			break
		}
		last = r
	}
	// When wrap-with-directory=true the LAST line's Hash is the wrapped dir CID.
	if last.Hash != "" {
		rootCID = last.Hash
	}
	if rootCID == "" {
		return "", fmt.Errorf("add returned no root hash")
	}

	// Silence "pin" — add already pinned via ?pin=true.
	return rootCID, nil
}

// ExportCAR exports a CID to a CAR file using /api/v0/dag/export.
// The CAR file contains the full DAG rooted at cid (all blocks).
// This is useful for backup, offline distribution, or pinning services.
func (c *Client) ExportCAR(cid, carPath string) error {
	endpoint := c.Endpoint
	if endpoint == "" {
		endpoint = "http://localhost:5001"
	}

	url := fmt.Sprintf("%s/api/v0/dag/export?arg=%s", endpoint, cid)
	req, err := newRequest("GET", url, nil)
	if err != nil {
		return err
	}

	resp, err := doRequest(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	// Response body is the raw CAR file content
	f, err := os.Create(carPath)
	if err != nil {
		return fmt.Errorf("create car file: %w", err)
	}
	defer f.Close()

	if _, err := io.Copy(f, resp.Body); err != nil {
		return fmt.Errorf("write car file: %w", err)
	}

	return nil
}

// addTree walks dirPath and writes every file into the multipart body.
// The `prefix` carries the relative path (e.g. "v0") so the wrapper
// reconstructs the directory structure.
func addTree(writer *multipart.Writer, dirPath, prefix string) error {
	entries, err := os.ReadDir(dirPath)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		rel := entry.Name()
		if prefix != "" {
			rel = prefix + "/" + entry.Name()
		}
		full := filepath.Join(dirPath, entry.Name())
		if entry.IsDir() {
			if err := addTree(writer, full, rel); err != nil {
				return err
			}
			continue
		}
		hdr := &multipart.FileHeader{}
		_ = hdr // placeholder (not used)
		f, err := os.Open(full)
		if err != nil {
			return err
		}
		part, err := writer.CreateFormFile("file", rel)
		if err != nil {
			f.Close()
			return err
		}
		if _, err := io.Copy(part, f); err != nil {
			f.Close()
			return err
		}
		f.Close()
	}
	return nil
}

var httpClient = &http.Client{Timeout: 300 * time.Second}

func newRequest(method, url string, body io.Reader) (*http.Request, error) {
	return http.NewRequest(method, url, body)
}

func doRequest(req *http.Request) (*http.Response, error) {
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request %s: %w", req.URL.Path, err)
	}
	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(b))
	}
	return resp, nil
}
