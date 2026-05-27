package api

import (
	"crypto/rand"
	"encoding/hex"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func (h *Handler) UploadLogo(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(5 << 20); err != nil {
		writeError(w, "file too large (max 5MB)", http.StatusBadRequest)
		return
	}

	file, header, err := r.FormFile("logo")
	if err != nil {
		writeError(w, "missing file field 'logo'", http.StatusBadRequest)
		return
	}
	defer file.Close()

	ext := strings.ToLower(filepath.Ext(header.Filename))
	allowed := map[string]bool{".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true, ".svg": true}
	if !allowed[ext] {
		writeError(w, "unsupported image format", http.StatusBadRequest)
		return
	}

	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		writeError(w, "internal error", http.StatusInternalServerError)
		return
	}
	filename := hex.EncodeToString(b) + ext

	uploadsDir := filepath.Join(h.DataDir, "uploads")
	if err := os.MkdirAll(uploadsDir, 0755); err != nil {
		writeError(w, "storage error", http.StatusInternalServerError)
		return
	}

	dst, err := os.Create(filepath.Join(uploadsDir, filename))
	if err != nil {
		writeError(w, "storage error", http.StatusInternalServerError)
		return
	}
	defer dst.Close()

	if _, err := io.Copy(dst, file); err != nil {
		writeError(w, "write error", http.StatusInternalServerError)
		return
	}

	writeJSON(w, map[string]string{"url": "/uploads/" + filename})
}
