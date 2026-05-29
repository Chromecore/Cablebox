package api

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

func NewRouter(h *Handler, frontendDir string, dataDir string) http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(middleware.RealIP)

	// Permissive CORS for local network use
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if origin != "" {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
				w.Header().Set("Vary", "Origin")
			}
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	})

	// Static file uploads
	uploadsDir := filepath.Join(dataDir, "uploads")
	os.MkdirAll(uploadsDir, 0755)
	r.Handle("/uploads/*", http.StripPrefix("/uploads/", http.FileServer(http.Dir(uploadsDir))))

	r.Route("/api", func(r chi.Router) {
		r.Get("/health", h.Health)

		// Channels
		r.Get("/channels", h.ListChannels)
		r.Post("/channels", h.CreateChannel)
		r.Put("/channels/{id}", h.UpdateChannel)
		r.Delete("/channels/{id}", h.DeleteChannel)
		r.Post("/channels/reorder", h.ReorderChannels)
		r.Post("/upload", h.UploadLogo)

		// Schedule
		r.Get("/schedule", h.GetSchedule)
		r.Post("/schedule", h.CreateBlock)
		r.Put("/schedule/{id}", h.UpdateBlock)
		r.Delete("/schedule/{id}", h.DeleteBlock)
		r.Get("/schedule/group/{groupId}", h.GetGroup)
		r.Delete("/schedule/group/{groupId}", h.DeleteGroup)
		r.Delete("/schedule/all", h.ClearSchedule)

		// Live "what's on now"
		r.Get("/now", h.GetNow)

		// Video streaming — routes Jellyfin content through cablebox so all devices
		// only need to reach cablebox (avoids auth-forward on jellyfin.internal).
		r.Get("/stream-file", h.StreamFile)     // direct static file with range support (primary)
		r.Get("/stream-proxy", h.StreamProxy)   // HLS playlist proxy (kept for fallback)
		r.Get("/stream-segment", h.StreamSegment)

		// Jellyfin library
		r.Get("/library/shows", h.GetShows)
		r.Get("/library/shows/{showId}/episodes", h.GetEpisodesForShow)
		r.Get("/library/movies", h.GetMovies)
		r.Get("/library/videos/browse", h.BrowseVideos)
		r.Get("/library/test", h.TestJellyfin)

		// App config
		r.Get("/config", h.GetAppConfig)
		r.Post("/config", h.UpdateAppConfig)
		r.Get("/airplay-url", h.GetAirPlayURL)
		r.Post("/update", h.TriggerUpdate)
		r.Post("/shutdown", h.TriggerShutdown)

		// Per-device key bindings (device identified by cb-device-id cookie)
		r.Get("/keybindings", h.GetKeybindings)
		r.Post("/keybindings", h.SetKeybindings)

		// Admin PIN auth
		r.Post("/auth/pin", h.VerifyPIN)
	})

	// Auth exchange — redeems hub login token and sets local auth cookie
	r.Get("/_auth/exchange", authExchangeHandler)

	// SPA fallback
	absFrontend, err := filepath.Abs(frontendDir)
	if err != nil {
		panic("cannot resolve frontend dir: " + err.Error())
	}
	fs := http.FileServer(http.Dir(frontendDir))
	r.Handle("/*", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cleaned := filepath.Join(absFrontend, filepath.Clean("/"+r.URL.Path))
		if !strings.HasPrefix(cleaned, absFrontend+string(filepath.Separator)) && cleaned != absFrontend {
			http.NotFound(w, r)
			return
		}
		if _, err := os.Stat(cleaned); os.IsNotExist(err) {
			http.ServeFile(w, r, filepath.Join(absFrontend, "index.html"))
			return
		}
		fs.ServeHTTP(w, r)
	}))

	return r
}

func authExchangeHandler(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	to := r.URL.Query().Get("to")
	if token == "" {
		http.Error(w, "missing token", http.StatusBadRequest)
		return
	}
	if !strings.HasPrefix(to, "/") || strings.HasPrefix(to, "//") {
		to = "/"
	}
	resp, err := http.Get("http://auth:8100/auth/exchange?token=" + url.QueryEscape(token))
	if err != nil || resp.StatusCode != http.StatusOK {
		http.Error(w, "invalid token", http.StatusUnauthorized)
		return
	}
	defer resp.Body.Close()
	var result struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil || result.Token == "" {
		http.Error(w, "invalid response", http.StatusUnauthorized)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     "auth_token",
		Value:    result.Token,
		Path:     "/",
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteNoneMode,
		MaxAge:   8 * 3600,
	})
	http.Redirect(w, r, to, http.StatusFound)
}

// GetEpisodesForShow extracts showId from URL param and delegates.
func (h *Handler) GetEpisodesForShow(w http.ResponseWriter, r *http.Request) {
	showID := chi.URLParam(r, "showId")

	jfURL, _ := h.DB.GetConfig("jellyfin_url")
	jfKey, _ := h.DB.GetConfig("jellyfin_api_key")
	jfUser, _ := h.DB.GetConfig("jellyfin_user_id")

	if jfURL == "" {
		writeError(w, "jellyfin not configured", http.StatusServiceUnavailable)
		return
	}

	client := &jellyfinClient{baseURL: jfURL, apiKey: jfKey, userID: jfUser}
	episodes, err := client.GetEpisodes(showID)
	if err != nil {
		writeError(w, "jellyfin error: "+err.Error(), http.StatusBadGateway)
		return
	}

	writeJSON(w, episodes)
}
