package main

import (
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/cablebox/cablebox/internal/api"
	"github.com/cablebox/cablebox/internal/db"
)

func main() {
	dataDir := getEnv("DATA_DIR", "/app/data")
	frontendDir := getEnv("FRONTEND_DIR", "/app/frontend/dist")
	port := getEnv("PORT", "8080")
	host := getEnv("HOST", "0.0.0.0")

	if err := os.MkdirAll(dataDir, 0755); err != nil {
		log.Fatalf("Failed to create data dir: %v", err)
	}

	database, err := db.New(dataDir + "/cablebox.db")
	if err != nil {
		log.Fatalf("Failed to init database: %v", err)
	}
	defer database.Close()

	// Seed Jellyfin connection from env vars — always wins over DB so
	// the compose file is the single source of truth on the server.
	if v := os.Getenv("JELLYFIN_URL"); v != "" {
		if err := database.SetConfig("jellyfin_url", v); err != nil {
			log.Printf("Warning: could not seed jellyfin_url: %v", err)
		}
	}
	if v := strings.TrimSpace(os.Getenv("JELLYFIN_API_KEY")); v != "" {
		if err := database.SetConfig("jellyfin_api_key", v); err != nil {
			log.Printf("Warning: could not seed jellyfin_api_key: %v", err)
		}
	}
	// Public Jellyfin URL the browser uses for images and streams (defaults to https://jellyfin.internal).
	jellyfinPublicURL := getEnv("JELLYFIN_PUBLIC_URL", "https://jellyfin.internal")
	if err := database.SetConfig("jellyfin_public_url", jellyfinPublicURL); err != nil {
		log.Printf("Warning: could not seed jellyfin_public_url: %v", err)
	}

	h := api.NewHandler(database, dataDir)
	router := api.NewRouter(h, frontendDir, dataDir)

	addr := host + ":" + port
	log.Printf("CableBox starting on http://%s", addr)
	log.Fatal(http.ListenAndServe(addr, router))
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
