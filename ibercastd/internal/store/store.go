// Package store provides JSON-file persistence for station data.
// Writes use atomic tmp+rename to prevent corruption.
package store

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// --- Entity types ---

type Channel struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

type Video struct {
	ID          string  `json:"id"`
	Title       string  `json:"title"`
	CID         string  `json:"cid"`
	HLSUrl      string  `json:"hlsUrl"`
	Duration    float64 `json:"duration"`
	Qualities   []QualityInfo `json:"qualities,omitempty"`
	ThumbnailURL string `json:"thumbnailUrl,omitempty"`
}

// QualityInfo describes an HLS quality level (mirrors publish.QualityInfo).
type QualityInfo struct {
	Name     string  `json:"name"`
	Label    string  `json:"label"`
	Bitrate  string  `json:"bitrate"`
	Duration float64 `json:"duration"`
}

type ParrillaSlot struct {
	ID        string  `json:"id"`
	ChannelID string  `json:"channelId"`
	DayOfWeek int     `json:"dayOfWeek"` // 0-6 (Sunday-Saturday)
	TimeStart string  `json:"timeStart"` // HH:MM
	Type      string  `json:"type"`      // "vod", "ad", "live"
	Ref       string  `json:"ref"`       // Video or Ad ID
}

// Ad is the advertisment entity. Schema only in this phase — no playback.
type Ad struct {
	ID       string  `json:"id"`
	Title    string  `json:"title"`
	CID      string  `json:"cid"`
	HLSUrl   string  `json:"hlsUrl"`
	Duration float64 `json:"duration"`
}

// Effect is a visual overlay (logo/text/overlay). Schema only in this phase —
// rendering is out of scope.
type Effect struct {
	ID     string                 `json:"id"`
	Type   string                 `json:"type"` // "logo", "text", "overlay"
	Params map[string]interface{} `json:"params"`
}

// LiveStream represents an active live streaming session.
type LiveStream struct {
	ID          string    `json:"id"`
	ChannelID   string    `json:"channelId"`
	Title       string    `json:"title"`
	Status      string    `json:"status"` // "live", "pending", "ended"
	StartedAt   time.Time `json:"startedAt"`
	StreamKey   string    `json:"streamKey,omitempty"` // RTMP path key: ic_<hex>
	CurrentCID  string    `json:"currentCid,omitempty"`
	HLSUrl      string    `json:"hlsUrl,omitempty"`
	Duration    float64   `json:"duration"`
	Qualities   []QualityInfo `json:"qualities,omitempty"`
}

type ResolvedSlot struct {
	ID         string      `json:"id"`
	ChannelID  string      `json:"channelId"`
	DayOfWeek  int         `json:"dayOfWeek"`
	TimeStart  string      `json:"timeStart"`
	Type       string      `json:"type"`
	Ref        interface{} `json:"ref"` // Video object or null
	Unresolved bool        `json:"unresolved,omitempty"`
}

// --- Store ---

type Store struct {
	dir         string
	mu          sync.RWMutex
	channels    []Channel
	videos      []Video
	parrilla    []ParrillaSlot
	ads         []Ad
	effects     []Effect
	liveStreams []LiveStream
}

// New creates a Store and loads (or initialises) data from dir.
func New(dir string) (*Store, error) {
	s := &Store{dir: dir}
	if err := s.loadOrCreate(); err != nil {
		return nil, err
	}
	return s, nil
}

// --- Atomic write helper ---

func (s *Store) writeJSON(filename string, data interface{}) error {
	path := filepath.Join(s.dir, filename)
	tmp := path + ".tmp"
	raw, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal %s: %w", filename, err)
	}
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return fmt.Errorf("write tmp %s: %w", filename, err)
	}
	return os.Rename(tmp, path)
}

func (s *Store) readJSON(filename string, out interface{}) error {
	path := filepath.Join(s.dir, filename)
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil // file doesn't yet exist; zero-value out is fine
		}
		return fmt.Errorf("read %s: %w", filename, err)
	}
	return json.Unmarshal(raw, out)
}

// --- loadOrCreate ---

func (s *Store) loadOrCreate() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := s.readJSON("channels.json", &s.channels); err != nil {
		return err
	}
	if err := s.readJSON("videos.json", &s.videos); err != nil {
		return err
	}
	if err := s.readJSON("parrilla.json", &s.parrilla); err != nil {
		return err
	}
	if err := s.readJSON("ads.json", &s.ads); err != nil {
		return err
	}
	if err := s.readJSON("effects.json", &s.effects); err != nil {
		return err
	}
	if err := s.readJSON("live.json", &s.liveStreams); err != nil {
		return err
	}

	// Default channel if none exist
	if len(s.channels) == 0 {
		s.channels = []Channel{
			{ID: "default", Name: "IberCast", Description: "Default channel"},
		}
		if err := s.writeJSON("channels.json", s.channels); err != nil {
			return fmt.Errorf("init default channel: %w", err)
		}
	}
	// Keep ads/effects collections materialised so they survive restart
	// even when the station has never mutated them.
	if s.ads == nil {
		s.ads = []Ad{}
		if err := s.writeJSON("ads.json", s.ads); err != nil {
			return fmt.Errorf("init ads: %w", err)
		}
	}
	if s.effects == nil {
		s.effects = []Effect{}
		if err := s.writeJSON("effects.json", s.effects); err != nil {
			return fmt.Errorf("init effects: %w", err)
		}
	}
	return nil
}

// --- Channels CRUD ---

// AddChannel appends a channel, rejecting duplicate IDs.
func (s *Store) AddChannel(c Channel) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, ch := range s.channels {
		if ch.ID == c.ID {
			return fmt.Errorf("channel %q already exists", c.ID)
		}
	}
	s.channels = append(s.channels, c)
	return s.writeJSON("channels.json", s.channels)
}

// --- Videos CRUD ---

func (s *Store) LoadVideos() []Video {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Video, len(s.videos))
	copy(out, s.videos)
	return out
}

func (s *Store) GetVideo(id string) (Video, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, v := range s.videos {
		if v.ID == id {
			return v, true
		}
	}
	return Video{}, false
}

func (s *Store) SaveVideo(v Video) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.videos = append(s.videos, v)
	return s.writeJSON("videos.json", s.videos)
}

func (s *Store) DeleteVideo(id string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, v := range s.videos {
		if v.ID == id {
			s.videos = append(s.videos[:i], s.videos[i+1:]...)
			return true, s.writeJSON("videos.json", s.videos)
		}
	}
	return false, nil
}

// --- Ads & Effects (schema-only entities) ---

func (s *Store) Ads() []Ad {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Ad, len(s.ads))
	copy(out, s.ads)
	return out
}

func (s *Store) Effects() []Effect {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Effect, len(s.effects))
	copy(out, s.effects)
	return out
}

func (s *Store) SaveAd(a Ad) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ads = append(s.ads, a)
	return s.writeJSON("ads.json", s.ads)
}

func (s *Store) SaveEffect(e Effect) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.effects = append(s.effects, e)
	return s.writeJSON("effects.json", s.effects)
}

// --- Parrilla CRUD ---

func (s *Store) LoadParrilla() []ParrillaSlot {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]ParrillaSlot, len(s.parrilla))
	copy(out, s.parrilla)
	return out
}

func (s *Store) GetParrilla(id string) (ParrillaSlot, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, p := range s.parrilla {
		if p.ID == id {
			return p, true
		}
	}
	return ParrillaSlot{}, false
}

func (s *Store) SaveParrilla(p ParrillaSlot) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.parrilla = append(s.parrilla, p)
	return s.writeJSON("parrilla.json", s.parrilla)
}

func (s *Store) UpdateParrilla(id string, p ParrillaSlot) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, slot := range s.parrilla {
		if slot.ID == id {
			s.parrilla[i] = p
			return true, s.writeJSON("parrilla.json", s.parrilla)
		}
	}
	return false, nil
}

func (s *Store) DeleteParrilla(id string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, p := range s.parrilla {
		if p.ID == id {
			s.parrilla = append(s.parrilla[:i], s.parrilla[i+1:]...)
			return true, s.writeJSON("parrilla.json", s.parrilla)
		}
	}
	return false, nil
}

// --- Resolve parrilla ---

// ResolveParrilla returns ResolvedSlots for a given channel and day,
// replacing each ref ID with the actual Video object (or null + unresolved).
func (s *Store) ResolveParrilla(channelID string, day int) []ResolvedSlot {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var out []ResolvedSlot
	for _, p := range s.parrilla {
		if p.ChannelID != channelID || p.DayOfWeek != day {
			continue
		}
		rs := ResolvedSlot{
			ID:        p.ID,
			ChannelID: p.ChannelID,
			DayOfWeek: p.DayOfWeek,
			TimeStart: p.TimeStart,
			Type:      p.Type,
		}
		// Try to resolve ref
		found := false
		for _, v := range s.videos {
			if v.ID == p.Ref {
				rs.Ref = v
				found = true
				break
			}
		}
		if !found && p.Ref != "" {
			rs.Ref = nil
			rs.Unresolved = true
		} else if !found && p.Ref == "" {
			rs.Ref = nil
		}
		out = append(out, rs)
	}
	if out == nil {
		out = []ResolvedSlot{}
	}
	return out
}

// HasOverlap checks if a new slot overlaps with existing slots for the same channel/day.
func (s *Store) HasOverlap(channelID string, day int, timeStart string, excludeID string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, p := range s.parrilla {
		if p.ChannelID != channelID || p.DayOfWeek != day || p.ID == excludeID {
			continue
		}
		if p.TimeStart == timeStart {
			return true
		}
	}
	return false
}

// Channels returns loaded channels.
func (s *Store) Channels() []Channel {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Channel, len(s.channels))
	copy(out, s.channels)
	return out
}

// --- Live Stream CRUD ---

func (s *Store) SaveLiveStream(ls LiveStream) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.liveStreams = append(s.liveStreams, ls)
	return s.writeJSON("live.json", s.liveStreams)
}

func (s *Store) GetLiveStream(id string) (LiveStream, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, ls := range s.liveStreams {
		if ls.ID == id {
			return ls, true
		}
	}
	return LiveStream{}, false
}

func (s *Store) UpdateLiveStream(id string, ls LiveStream) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, stream := range s.liveStreams {
		if stream.ID == id {
			s.liveStreams[i] = ls
			_ = s.writeJSON("live.json", s.liveStreams)
			return
		}
	}
}

func (s *Store) DeleteLiveStream(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, ls := range s.liveStreams {
		if ls.ID == id {
			s.liveStreams = append(s.liveStreams[:i], s.liveStreams[i+1:]...)
			_ = s.writeJSON("live.json", s.liveStreams)
			return true
		}
	}
	return false
}

func (s *Store) LoadLiveStreams() []LiveStream {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]LiveStream, len(s.liveStreams))
	copy(out, s.liveStreams)
	return out
}
