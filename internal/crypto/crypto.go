// Package crypto implements AES-256-GCM encryption for provider API keys,
// matching the $aes256gcm: format used by the TypeScript proxy so existing
// encrypted keys remain decryptable.
package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
	"sync"

	"golang.org/x/crypto/scrypt"
)

const (
	prefix    = "$aes256gcm:"
	saltBytes = 16
	ivBytes   = 12
	scryptN   = 131072
	scryptR   = 8
	scryptP   = 1
	dkLen     = 32
)

// keyCache avoids re-running the ~100-200ms scrypt derivation for the same
// (masterSecret, salt) pair within a process lifetime.
var (
	keyCacheMu sync.Mutex
	keyCache   = map[string][]byte{}
)

func deriveKey(masterSecret string, salt []byte) ([]byte, error) {
	fp := hex.EncodeToString(fingerprint(masterSecret, salt))
	keyCacheMu.Lock()
	if k, ok := keyCache[fp]; ok {
		keyCacheMu.Unlock()
		return k, nil
	}
	keyCacheMu.Unlock()

	key, err := scrypt.Key([]byte(masterSecret), salt, scryptN, scryptR, scryptP, dkLen)
	if err != nil {
		return nil, err
	}

	keyCacheMu.Lock()
	keyCache[fp] = key
	keyCacheMu.Unlock()
	return key, nil
}

func fingerprint(masterSecret string, salt []byte) []byte {
	h := sha256.New()
	h.Write([]byte(masterSecret))
	h.Write(salt)
	return h.Sum(nil)[:16]
}

// Encrypt returns the $aes256gcm: encoding of plaintext under masterSecret.
func Encrypt(plaintext, masterSecret string) (string, error) {
	salt := make([]byte, saltBytes)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	iv := make([]byte, ivBytes)
	if _, err := rand.Read(iv); err != nil {
		return "", err
	}
	key, err := deriveKey(masterSecret, salt)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	sealed := gcm.Seal(nil, iv, []byte(plaintext), nil)
	tagSize := gcm.Overhead()
	ciphertext := sealed[:len(sealed)-tagSize]
	authTag := sealed[len(sealed)-tagSize:]

	return prefix + strings.Join([]string{
		base64.StdEncoding.EncodeToString(salt),
		base64.StdEncoding.EncodeToString(iv),
		base64.StdEncoding.EncodeToString(authTag),
		base64.StdEncoding.EncodeToString(ciphertext),
	}, ":"), nil
}

// Decrypt recovers the plaintext from a $aes256gcm: encoded value.
func Decrypt(encoded, masterSecret string) (string, error) {
	if !strings.HasPrefix(encoded, prefix) {
		return "", errors.New("not an encrypted value")
	}
	parts := strings.Split(strings.TrimPrefix(encoded, prefix), ":")
	if len(parts) != 4 {
		return "", errors.New("invalid encrypted value format")
	}
	salt, err := base64.StdEncoding.DecodeString(parts[0])
	if err != nil {
		return "", err
	}
	iv, err := base64.StdEncoding.DecodeString(parts[1])
	if err != nil {
		return "", err
	}
	authTag, err := base64.StdEncoding.DecodeString(parts[2])
	if err != nil {
		return "", err
	}
	ciphertext, err := base64.StdEncoding.DecodeString(parts[3])
	if err != nil {
		return "", err
	}

	key, err := deriveKey(masterSecret, salt)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	combined := append(ciphertext, authTag...)
	plaintext, err := gcm.Open(nil, iv, combined, nil)
	if err != nil {
		return "", err
	}
	return string(plaintext), nil
}
