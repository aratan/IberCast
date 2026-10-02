// Package store provides JSON-file persistence for station data.
// Writes use atomic tmp+rename to prevent corruption.
package store

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"strings"
	"time"

)

// --- Entity types ---

type Channel struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

type Video struct {
	ID             string        `json:"id"`
	Title          string        `json:"title"`
	CID            string        `json:"cid"`
	HLSUrl         string        `json:"hlsUrl"`
	Duration       float64       `json:"duration"`
	ChannelID      string        `json:"channelId,omitempty"` // empty means "default"
	Qualities      []QualityInfo `json:"qualities,omitempty"`
	ThumbnailURL   string        `json:"thumbnailUrl,omitempty"`
	OwnerID        string        `json:"ownerId,omitempty"`
	OwnerUsername  string        `json:"ownerUsername,omitempty"`
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

type ResolvedSlot struct {
	ID         string      `json:"id"`
	ChannelID  string      `json:"channelId"`
	DayOfWeek  int         `json:"dayOfWeek"`
	TimeStart  string      `json:"timeStart"`
	Type       string      `json:"type"`
	Ref        interface{} `json:"ref"` // Video object or null
	Unresolved bool        `json:"unresolved,omitempty"`
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
	ID          string         `json:"id"`
	ChannelID   string         `json:"channelId"`
	Title       string         `json:"title"`
	Status      string         `json:"status"` // "live", "pending", "ended"
	StartedAt   time.Time      `json:"startedAt"`
	StreamKey   string         `json:"streamKey,omitempty"` // RTMP path key: ic_<hex>
	CurrentCID  string         `json:"currentCid,omitempty"`
	HLSUrl      string         `json:"hlsUrl,omitempty"`
	Duration    float64        `json:"duration"`
	Qualities   []QualityInfo  `json:"qualities,omitempty"`
}

// User represents an authenticated user with role-based access control.
type User struct {
	ID                   string    `json:"id"`
	Username             string    `json:"username"`
	Role                 string    `json:"role"` // "admin" or "uploader"
	PasswordHash         string    `json:"passwordHash"`
	Active               bool      `json:"active"`
	ForcePasswordChange  bool      `json:"forcePasswordChange"`
	LastLoginAt          time.Time `json:"lastLoginAt,omitempty"`
	CreatedAt            time.Time `json:"createdAt"`
	UpdatedAt            time.Time `json:"updatedAt"`
	VideosOwned          int       `json:"videosOwned"`
}

// Session represents an authenticated session with CSRF protection.
type Session struct {
	ID        string    `json:"id"`
	UserID    string    `json:"userId"`
	Username  string    `json:"username"`
	Role      string    `json:"role"`
	CSRF      string    `json:"csrf"`
	ExpiresAt time.Time `json:"expiresAt"`
	LastSeen  time.Time `json:"lastSeen"`
	CreatedAt time.Time `json:"createdAt"`
	IP        string    `json:"ip,omitempty"`
	UserAgent string    `json:"userAgent,omitempty"`
}

// AuditEvent represents an audit log entry (append-only).
type AuditEvent struct {
	Timestamp time.Time `json:"timestamp"`
	Action    string    `json:"action"`
	UserID    string    `json:"userId,omitempty"`
	Username  string    `json:"username,omitempty"`
	Role      string    `json:"role,omitempty"`
	Target    string    `json:"target,omitempty"`
	Details   string    `json:"details,omitempty"`
	IP        string    `json:"ip,omitempty"`
}

type Store struct {
	dir         string
	mu          sync.RWMutex
	channels    []Channel
	videos      []Video
	parrilla    []ParrillaSlot
	ads         []Ad
	effects     []Effect
	liveStreams []LiveStream
	users       []User
	sessions    []Session
	auditEvents []AuditEvent
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
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("rename %s: %w", filename, err)
	}
	return nil
}

func (s *Store) loadOrCreate() error {
	if err := os.MkdirAll(s.dir, 0o755); err != nil {
		return err
	}
	if err := s.loadChannels(); err != nil {
		return err
	}
	if err := s.loadVideos(); err != nil {
		return err
	}
	if err := s.loadParrilla(); err != nil {
		return err
	}
	if err := s.loadAds(); err != nil {
		return err
	}
	if err := s.loadEffects(); err != nil {
		return err
	}
	if err := s.loadLive(); err != nil {
		return err
	}
	if err := s.loadUsers(); err != nil {
		return err
	}
	if err := s.loadSessions(); err != nil {
		return err
	}
	return nil
}

func (s *Store) loadChannels() error {
	path := filepath.Join(s.dir, "channels.json")
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		s.channels = []Channel{}
		return s.writeJSON("channels.json", s.channels)
	}
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, &s.channels)
}

func (s *Store) loadVideos() error {
	path := filepath.Join(s.dir, "videos.json")
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		s.videos = []Video{}
		return s.writeJSON("videos.json", s.videos)
	}
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, &s.videos)
}

func (s *Store) loadParrilla() error {
	path := filepath.Join(s.dir, "parrilla.json")
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		s.parrilla = []ParrillaSlot{}
		return s.writeJSON("parrilla.json", s.parrilla)
	}
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, &s.parrilla)
}

func (s *Store) loadAds() error {
	path := filepath.Join(s.dir, "ads.json")
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		s.ads = []Ad{}
		return nil
	}
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, &s.ads)
}

func (s *Store) loadEffects() error {
	path := filepath.Join(s.dir, "effects.json")
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		s.effects = []Effect{}
		return nil
	}
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, &s.effects)
}

func (s *Store) loadLive() error {
	path := filepath.Join(s.dir, "live.json")
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		s.liveStreams = []LiveStream{}
		return s.writeJSON("live.json", s.liveStreams)
	}
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, &s.liveStreams)
}

func (s *Store) loadUsers() error {
	path := filepath.Join(s.dir, "users.json")
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		s.users = []User{}
		return nil
	}
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, &s.users)
}

func (s *Store) loadSessions() error {
	path := filepath.Join(s.dir, "sessions.json")
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		s.sessions = []Session{}
		return nil
	}
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, &s.sessions)
}

func (s *Store) Channels() []Channel {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Channel, len(s.channels))
	copy(out, s.channels)
	return out
}

func (s *Store) AddChannel(ch Channel) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, c := range s.channels {
		if c.ID == ch.ID {
			return fmt.Errorf("channel %s already exists", ch.ID)
		}
	}
	s.channels = append(s.channels, ch)
	return s.writeJSON("channels.json", s.channels)
}

func (s *Store) SaveChannel(ch Channel) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, c := range s.channels {
		if c.ID == ch.ID {
			s.channels[i] = ch
			_ = s.writeJSON("channels.json", s.channels)
			return
		}
	}
	s.channels = append(s.channels, ch)
	_ = s.writeJSON("channels.json", s.channels)
}

func (s *Store) DeleteChannel(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, c := range s.channels {
		if c.ID == id {
			s.channels = append(s.channels[:i], s.channels[i+1:]...)
			_ = s.writeJSON("channels.json", s.channels)
			return true
		}
	}
	return false
}

func (s *Store) SaveVideo(v Video) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, vd := range s.videos {
		if vd.ID == v.ID {
			s.videos[i] = v
			return s.writeJSON("videos.json", s.videos)
		}
	}
	s.videos = append(s.videos, v)
	return s.writeJSON("videos.json", s.videos)
}

func (s *Store) GetVideo(id string) (Video, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, vd := range s.videos {
		if vd.ID == id {
			return vd, true
		}
	}
	return Video{}, false
}

func (s *Store) DeleteVideo(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, vd := range s.videos {
		if vd.ID == id {
			s.videos = append(s.videos[:i], s.videos[i+1:]...)
			_ = s.writeJSON("videos.json", s.videos)
			return true
		}
	}
	return false
}

func (s *Store) LoadVideos() []Video {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Video, len(s.videos))
	copy(out, s.videos)
	return out
}

func (s *Store) SaveParrilla(p []ParrillaSlot) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.parrilla = make([]ParrillaSlot, len(p))
	copy(s.parrilla, p)
	return s.writeJSON("parrilla.json", s.parrilla)
}

func (s *Store) LoadParrilla() []ParrillaSlot {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]ParrillaSlot, len(s.parrilla))
	copy(out, s.parrilla)
	return out
}

func (s *Store) ResolveParrilla() []ResolvedSlot {
	s.mu.RLock()
	defer s.mu.RUnlock()
	res := make([]ResolvedSlot, 0, len(s.parrilla))
	for _, slot := range s.parrilla {
		rs := ResolvedSlot{
			ID:        slot.ID,
			ChannelID: slot.ChannelID,
			DayOfWeek: slot.DayOfWeek,
			TimeStart: slot.TimeStart,
			Type:      slot.Type,
		}
		if slot.Type == "vod" {
			if v, ok := s.getVideoNoLock(slot.Ref); ok {
				rs.Ref = v
				rs.Unresolved = false
			} else {
				rs.Ref = nil
				rs.Unresolved = true
			}
		} else {
			rs.Ref = nil
			rs.Unresolved = false
		}
		res = append(res, rs)
	}
	return res
}

func (s *Store) getVideoNoLock(id string) (Video, bool) {
	for _, vd := range s.videos {
		if vd.ID == id {
			return vd, true
		}
	}
	return Video{}, false
}

func (s *Store) HasOverlap(slot ParrillaSlot) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, existing := range s.parrilla {
		if existing.ChannelID == slot.ChannelID && existing.DayOfWeek == slot.DayOfWeek && existing.TimeStart == slot.TimeStart {
			return true
		}
	}
	return false
}

func (s *Store) UpdateParrillaSlot(id string, slot ParrillaSlot) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, existing := range s.parrilla {
		if existing.ID == id {
			s.parrilla[i] = slot
			_ = s.writeJSON("parrilla.json", s.parrilla)
			return
		}
	}
}

func (s *Store) DeleteParrillaSlot(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, existing := range s.parrilla {
		if existing.ID == id {
			s.parrilla = append(s.parrilla[:i], s.parrilla[i+1:]...)
			_ = s.writeJSON("parrilla.json", s.parrilla)
			return true
		}
	}
	return false
}

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



func (s *Store) ResolveParrillaFiltered(channelID string, day int) []ResolvedSlot {
	s.mu.RLock()
	defer s.mu.RUnlock()
	res := make([]ResolvedSlot, 0, len(s.parrilla))
	for _, slot := range s.parrilla {
		if channelID != "" && slot.ChannelID != channelID {
			continue
		}
		if day >= 0 && day <= 6 && slot.DayOfWeek != day {
			continue
		}
		rs := ResolvedSlot{
			ID:        slot.ID,
			ChannelID: slot.ChannelID,
			DayOfWeek: slot.DayOfWeek,
			TimeStart: slot.TimeStart,
			Type:      slot.Type,
		}
		if slot.Type == "vod" {
			if v, ok := s.getVideoNoLock(slot.Ref); ok {
				rs.Ref = v
				rs.Unresolved = false
			} else {
				rs.Ref = nil
				rs.Unresolved = true
			}
		} else {
			rs.Ref = nil
			rs.Unresolved = false
		}
		res = append(res, rs)
	}
	return res
}

func (s *Store) SaveParrillaSlot(slot ParrillaSlot) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.parrilla = append(s.parrilla, slot)
	return s.writeJSON("parrilla.json", s.parrilla)
}

func (s *Store) HasOverlapSlot(slot ParrillaSlot) bool {
	return s.HasOverlap2(slot.ChannelID, slot.DayOfWeek, slot.TimeStart, "")
}

func (s *Store) HasOverlap2(channelID string, dayOfWeek int, timeStart string, excludeID string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, existing := range s.parrilla {
		if excludeID != "" && existing.ID == excludeID {
			continue
		}
		if existing.ChannelID == channelID && existing.DayOfWeek == dayOfWeek && existing.TimeStart == timeStart {
			return true
		}
	}
	return false
}

func (s *Store) UpdateParrilla(id string, slot ParrillaSlot) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, existing := range s.parrilla {
		if existing.ID == id {
			s.parrilla[i] = slot
			return true, s.writeJSON("parrilla.json", s.parrilla)
		}
	}
	return false, nil
}

func (s *Store) DeleteParrilla(id string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, existing := range s.parrilla {
		if existing.ID == id {
			s.parrilla = append(s.parrilla[:i], s.parrilla[i+1:]...)
			return true, s.writeJSON("parrilla.json", s.parrilla)
		}
	}
	return false, nil
}



func (s *Store) ListUsersSanitized() []User {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]User, len(s.users))
	for i, u := range s.users {
		out[i] = u
		out[i].PasswordHash = ""
	}
	return out
}

func (s *Store) GetUserByName(username string) (User, bool) {
	un := strings.ToLower(strings.TrimSpace(username))
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, u := range s.users {
		if strings.EqualFold(u.Username, un) {
			return u, true
		}
	}
	return User{}, false
}

func (s *Store) GetSession(id string) (Session, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, ss := range s.sessions {
		if ss.ID == id {
			return ss, true
		}
	}
	return Session{}, false
}

func (s *Store) DeleteSession(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, ss := range s.sessions {
		if ss.ID == id {
			s.sessions = append(s.sessions[:i], s.sessions[i+1:]...)
			_ = s.writeJSON("sessions.json", s.sessions)
			return true
		}
	}
	return false
}

func (s *Store) TouchSession(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, ss := range s.sessions {
		if ss.ID == id {
			if time.Now().After(ss.ExpiresAt) {
				continue
			}
			ss.LastSeen = time.Now()
			s.sessions[i] = ss
			_ = s.writeJSON("sessions.json", s.sessions)
			return true
		}
	}
	return false
}

func (s *Store) CreateSession(sess Session) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sessions = append(s.sessions, sess)
	return s.writeJSON("sessions.json", s.sessions)
}

func (s *Store) CleanupSessions() {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	n := 0
	for _, ss := range s.sessions {
		if now.After(ss.ExpiresAt) {
			continue
		}
		s.sessions[n] = ss
		n++
	}
	if n != len(s.sessions) {
		s.sessions = s.sessions[:n]
		_ = s.writeJSON("sessions.json", s.sessions)
	}
}

func (s *Store) AddUser(u User) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, ex := range s.users {
		if strings.EqualFold(ex.Username, u.Username) || ex.ID == u.ID {
			return fmt.Errorf("user exists")
		}
	}
	if u.CreatedAt.IsZero() {
		u.CreatedAt = time.Now()
	}
	u.UpdatedAt = time.Now()
	s.users = append(s.users, u)
	return s.writeJSON("users.json", s.users)
}

func (s *Store) CountAdminsActive() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	n := 0
	for _, u := range s.users {
		if u.Role == "admin" && u.Active {
			n++
		}
	}
	return n
}

func (s *Store) UpdateUser(u User) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, ex := range s.users {
		if ex.ID == u.ID {
			u.UpdatedAt = time.Now()
			s.users[i] = u
			return s.writeJSON("users.json", s.users)
		}
	}
	return fmt.Errorf("not found")
}

func (s *Store) DeleteUser(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, ex := range s.users {
		if ex.ID == id {
			s.users = append(s.users[:i], s.users[i+1:]...)
			_ = s.writeJSON("users.json", s.users)
			return true
		}
	}
	return false
}

func (s *Store) DeleteUserSessions(userID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, ss := range s.sessions {
		if ss.UserID == userID {
			continue
		}
		s.sessions[n] = ss
		n++
	}
	if n != len(s.sessions) {
		s.sessions = s.sessions[:n]
		_ = s.writeJSON("sessions.json", s.sessions)
	}
}

func (s *Store) GetUser(id string) (User, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, u := range s.users {
		if u.ID == id {
			return u, true
		}
	}
	return User{}, false
}
