package api

import (
	"database/sql"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
)

type Channel struct {
	ID        int64  `json:"id"`
	Number    int    `json:"number"`
	Name      string `json:"name"`
	LogoURL   string `json:"logoUrl"`
	SortOrder int    `json:"sortOrder"`
}

func (h *Handler) ListChannels(w http.ResponseWriter, r *http.Request) {
	rows, err := h.DB.Query(
		"SELECT id, number, name, logo_url, sort_order FROM channels ORDER BY sort_order, number",
	)
	if err != nil {
		writeError(w, "db error", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	channels := []Channel{}
	for rows.Next() {
		var ch Channel
		if err := rows.Scan(&ch.ID, &ch.Number, &ch.Name, &ch.LogoURL, &ch.SortOrder); err != nil {
			writeError(w, "scan error", http.StatusInternalServerError)
			return
		}
		channels = append(channels, ch)
	}
	writeJSON(w, channels)
}

func (h *Handler) UpdateChannel(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		writeError(w, "invalid id", http.StatusBadRequest)
		return
	}

	var body struct {
		Name    string `json:"name"`
		LogoURL string `json:"logoUrl"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, "invalid json", http.StatusBadRequest)
		return
	}

	result, err := h.DB.Exec(
		"UPDATE channels SET name = ?, logo_url = ? WHERE id = ?",
		body.Name, body.LogoURL, id,
	)
	if err != nil {
		writeError(w, "db error", http.StatusInternalServerError)
		return
	}
	if n, _ := result.RowsAffected(); n == 0 {
		writeError(w, "not found", http.StatusNotFound)
		return
	}

	var ch Channel
	if err := h.DB.QueryRow(
		"SELECT id, number, name, logo_url, sort_order FROM channels WHERE id = ?", id,
	).Scan(&ch.ID, &ch.Number, &ch.Name, &ch.LogoURL, &ch.SortOrder); err != nil && err != sql.ErrNoRows {
		writeError(w, "db error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, ch)
}

func (h *Handler) CreateChannel(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name    string `json:"name"`
		LogoURL string `json:"logoUrl"`
	}
	decodeJSON(r, &body)

	var maxNum, maxSort int
	h.DB.QueryRow("SELECT COALESCE(MAX(number),0), COALESCE(MAX(sort_order),0) FROM channels").Scan(&maxNum, &maxSort)

	number := maxNum + 1
	sortOrder := maxSort + 1
	if body.Name == "" {
		body.Name = ""
	}

	result, err := h.DB.Exec(
		"INSERT INTO channels (number, name, logo_url, sort_order) VALUES (?, ?, ?, ?)",
		number, body.Name, body.LogoURL, sortOrder,
	)
	if err != nil {
		writeError(w, "db error", http.StatusInternalServerError)
		return
	}
	id, _ := result.LastInsertId()
	writeJSON(w, Channel{ID: id, Number: number, Name: body.Name, LogoURL: body.LogoURL, SortOrder: sortOrder})
}

func (h *Handler) DeleteChannel(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		writeError(w, "invalid id", http.StatusBadRequest)
		return
	}

	if _, err := h.DB.Exec("DELETE FROM channels WHERE id = ?", id); err != nil {
		writeError(w, "db error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (h *Handler) ReorderChannels(w http.ResponseWriter, r *http.Request) {
	var items []struct {
		ID        int64 `json:"id"`
		SortOrder int   `json:"sortOrder"`
		Number    int   `json:"number"`
	}
	if err := decodeJSON(r, &items); err != nil {
		writeError(w, "invalid json", http.StatusBadRequest)
		return
	}

	tx, err := h.DB.Begin()
	if err != nil {
		writeError(w, "db error", http.StatusInternalServerError)
		return
	}
	defer tx.Rollback()

	for _, item := range items {
		var execErr error
		if item.Number > 0 {
			_, execErr = tx.Exec("UPDATE channels SET sort_order = ?, number = ? WHERE id = ?", item.SortOrder, item.Number, item.ID)
		} else {
			_, execErr = tx.Exec("UPDATE channels SET sort_order = ? WHERE id = ?", item.SortOrder, item.ID)
		}
		if execErr != nil {
			writeError(w, "db error", http.StatusInternalServerError)
			return
		}
	}

	if err := tx.Commit(); err != nil {
		writeError(w, "db error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}
