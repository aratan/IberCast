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

// AddResult is the JSON response from /api/v0/add.
type AddResult struct {
	Name string `json:"Name"`
	Hash string `json:"Hash"`
	Size string `json:"Size"`
}

// Add uploads a directory to IPFS and returns the root CID.
func (c *Client) Add(dirPath string) (string, error) {
	endpoint := c.Endpoint
	if endpoint == "" {
		endpoint = "http://localhost:5001"
	}

	// Walk the directory and add all files
	entries, err := os.ReadDir(dirPath)
	if err != nil {
		return "", fmt.Errorf("read dir: %w", err)
	}

	var rootCID string
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
	 filePath := filepath.Join(dirPath, entry.Name())
		cid, err := c.addFile(endpoint, filePath, entry.Name())
		if err != nil {
			return "", fmt.Errorf("add %s: %w", entry.Name(), err)
		}
		if rootCID == "" {
			rootCID = cid
		}
	}

	// Pin the root CID
	if rootCID != "" {
		if err := c.pin(endpoint, rootCID); err != nil {
			return "", fmt.Errorf("pin: %w", err)
		}
	}

	return rootCID, nil
}

func (c *Client) addFile(endpoint, filePath, fieldName string) (string, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return "", err
	}
	defer f.Close()

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", filepath.Base(filePath))
	if err != nil {
		return "", err
	}
	if _, err := io.Copy(part, f); err != nil {
		return "", err
	}
	writer.Close()

	url := fmt.Sprintf("%s/api/v0/add?pin=true", endpoint)
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

	var result AddResult
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", fmt.Errorf("decode add response: %w", err)
	}

	if result.Hash == "" {
		return "", fmt.Errorf("add returned no hash")
	}
	return result.Hash, nil
}

func (c *Client) pin(endpoint, cid string) error {
	url := fmt.Sprintf("%s/api/v0/pin/add?arg=%s", endpoint, cid)
	req, err := newRequest("POST", url, nil)
	if err != nil {
		return err
	}
	resp, err := doRequest(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
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
