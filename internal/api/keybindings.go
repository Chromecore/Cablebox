package api

import (
	"crypto/rand"
	"fmt"
	"io"
	"net/http"
)

func newDeviceID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func getOrCreateDeviceID(w http.ResponseWriter, r *http.Request) string {
	if c, err := r.Cookie("cb-device-id"); err == nil && c.Value != "" {
		return c.Value
	}
	id := newDeviceID()
	http.SetCookie(w, &http.Cookie{
		Name:     "cb-device-id",
		Value:    id,
		Path:     "/",
		MaxAge:   10 * 365 * 24 * 3600, // 10 years
		SameSite: http.SameSiteLaxMode,
	})
	return id
}

// GetKeybindings returns the key bindings stored for this device.
func (h *Handler) GetKeybindings(w http.ResponseWriter, r *http.Request) {
	deviceID := getOrCreateDeviceID(w, r)
	val, err := h.DB.GetConfig("keybindings_" + deviceID)
	if err != nil || val == "" {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.Write([]byte("{}"))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Write([]byte(val))
}

// SetKeybindings persists key bindings for this device.
func (h *Handler) SetKeybindings(w http.ResponseWriter, r *http.Request) {
	deviceID := getOrCreateDeviceID(w, r)

	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeError(w, "read error", http.StatusBadRequest)
		return
	}
	if len(body) == 0 {
		body = []byte("{}")
	}

	if err := h.DB.SetConfig("keybindings_"+deviceID, string(body)); err != nil {
		writeError(w, "db error: "+err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}
