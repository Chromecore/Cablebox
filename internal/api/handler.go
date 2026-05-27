package api

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/cablebox/cablebox/internal/db"
)

type Handler struct {
	DB      *db.DB
	DataDir string

	// episode cache: showId -> (episodes, fetchedAt)
	epCacheMu   sync.RWMutex
	epCache     map[string][]JFEpisode
	epCacheTime map[string]time.Time
}

func NewHandler(database *db.DB, dataDir string) *Handler {
	return &Handler{
		DB:          database,
		DataDir:     dataDir,
		epCache:     make(map[string][]JFEpisode),
		epCacheTime: make(map[string]time.Time),
	}
}

func (h *Handler) Health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]string{"status": "ok"})
}

// ---- helpers ----

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, msg string, code int) {
	http.Error(w, msg, code)
}

func decodeJSON(r *http.Request, v any) error {
	return json.NewDecoder(r.Body).Decode(v)
}
