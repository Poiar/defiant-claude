package crypto

import "testing"

func TestEncryptDecryptRoundTrip(t *testing.T) {
	plaintext := "sk-ant-api03-secret-key-12345"
	master := "correct horse battery staple"
	encoded, err := Encrypt(plaintext, master)
	if err != nil {
		t.Fatal(err)
	}
	if len(encoded) < len(prefix) || encoded[:len(prefix)] != prefix {
		t.Fatalf("missing prefix: %q", encoded)
	}
	decoded, err := Decrypt(encoded, master)
	if err != nil {
		t.Fatal(err)
	}
	if decoded != plaintext {
		t.Fatalf("round-trip mismatch: got %q want %q", decoded, plaintext)
	}
}

func TestDecryptWrongKey(t *testing.T) {
	encoded, err := Encrypt("secret", "correct key")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Decrypt(encoded, "wrong key"); err == nil {
		t.Fatal("expected decryption failure with wrong key")
	}
}

func TestDecryptNotEncrypted(t *testing.T) {
	if _, err := Decrypt("plaintext-key", "master"); err == nil {
		t.Fatal("expected error for non-encrypted value")
	}
}

func TestDecryptMalformed(t *testing.T) {
	if _, err := Decrypt("$aes256gcm:only-two-parts", "master"); err == nil {
		t.Fatal("expected error for malformed value")
	}
}
