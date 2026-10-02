// Package auth provides password hashing (Argon2id), session/CSRF token
// generation and basic input validation helpers.
package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"golang.org/x/crypto/argon2"
)

var (
	ErrInvalidHash = errors.New("invalid password hash")
	validUser      = regexp.MustCompile(`^[a-zA-Z0-9._-]{3,32}$`)
	validID        = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)
)

type Params struct {
	Memory      uint32
	Iterations  uint32
	Parallelism uint8
	SaltLen     uint32
	KeyLen      uint32
}

var DefaultParams = &Params{
	Memory:      64 * 1024,
	Iterations:  3,
	Parallelism: 2,
	SaltLen:     16,
	KeyLen:      32,
}

// GenerateID returns a URL-safe random ID.
func GenerateID() (string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// SessionID returns a URL-safe random session ID.
func SessionID() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// CSRFToken returns a random CSRF token.
func CSRFToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// NewUUID returns a UUID v4 string.
func NewUUID() string {
	return uuid.NewString()
}

// HashPassword hashes a password using Argon2id.
func HashPassword(password string) (string, error) {
	salt := make([]byte, DefaultParams.SaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	hash := argon2.IDKey([]byte(password), salt, DefaultParams.Iterations, DefaultParams.Memory, DefaultParams.Parallelism, DefaultParams.KeyLen)
	var b strings.Builder
	b.Grow(128)
	b.WriteString("$argon2id$")
	fmt.Fprintf(&b, "m=%d,t=%d,p=%d$", DefaultParams.Memory, DefaultParams.Iterations, DefaultParams.Parallelism)
	b.WriteString(base64.RawStdEncoding.EncodeToString(salt))
	b.WriteByte('$')
	b.WriteString(base64.RawStdEncoding.EncodeToString(hash))
	return b.String(), nil
}

// VerifyPassword verifies a password against an Argon2id hash.
func VerifyPassword(password, encoded string) (bool, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false, ErrInvalidHash
	}
	var m, t uint32
	var p uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &m, &t, &p); err != nil {
		return false, err
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false, err
	}
	hash, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return false, err
	}
	other := argon2.IDKey([]byte(password), salt, t, m, p, uint32(len(hash)))
	if len(hash) != len(other) {
		return false, nil
	}
	if subtle.ConstantTimeCompare(hash, other) == 1 {
		return true, nil
	}
	return false, nil
}

// ValidUsername validates username format.
func ValidUsername(u string) bool {
	if len(u) < 3 || len(u) > 32 {
		return false
	}
	return validUser.MatchString(u)
}

// ValidID validates safe ID format.
func ValidID(id string) bool {
	if id == "" || len(id) > 64 {
		return false
	}
	return validID.MatchString(id)
}

// SessionExpiry returns default session expiry.
func SessionExpiry() time.Time {
	return time.Now().Add(8 * time.Hour)
}

// SessionIdleExpiry returns idle expiry.
func SessionIdleExpiry() time.Time {
	return time.Now().Add(30 * time.Minute)
}
