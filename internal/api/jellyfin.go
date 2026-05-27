package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

var jellyfinHTTPClient = &http.Client{Timeout: 10 * time.Second}

var errJellyfinNotConfigured = errors.New("jellyfin not configured")

type jellyfinClient struct {
	baseURL string
	apiKey  string
	userID  string
}

type JFShow struct {
	Id            string `json:"Id"`
	Name          string `json:"Name"`
	ImageTags     map[string]string `json:"ImageTags"`
	PrimaryImageTag string `json:"PrimaryImageTag"`
}

type JFEpisode struct {
	Id                string `json:"Id"`
	Name              string `json:"Name"`
	IndexNumber       int    `json:"IndexNumber"`
	ParentIndexNumber int    `json:"ParentIndexNumber"`
	SeriesName        string `json:"SeriesName"`
	SeriesId          string `json:"SeriesId"`
	SeasonId          string `json:"SeasonId"`
	RunTimeTicks      int64  `json:"RunTimeTicks"`
}

type jfItemsResponse struct {
	Items []json.RawMessage `json:"Items"`
}

func (c *jellyfinClient) get(path string, out any) error {
	url := strings.TrimRight(c.baseURL, "/") + path
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("X-Emby-Token", c.apiKey)
	req.Header.Set("Accept", "application/json")

	resp, err := jellyfinHTTPClient.Do(req)
	if err != nil {
		return fmt.Errorf("jellyfin request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized {
		return errors.New("jellyfin: unauthorized — check API key")
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("jellyfin: status %d: %s", resp.StatusCode, body)
	}

	return json.NewDecoder(resp.Body).Decode(out)
}

func (c *jellyfinClient) EnsureUserID() error {
	if c.userID != "" {
		return nil
	}
	var users []struct {
		Id string `json:"Id"`
	}
	if err := c.get("/Users", &users); err != nil {
		return err
	}
	if len(users) == 0 {
		return errors.New("jellyfin: no users found")
	}
	c.userID = users[0].Id
	return nil
}

func (c *jellyfinClient) GetShows() ([]JFShow, error) {
	if err := c.EnsureUserID(); err != nil {
		return nil, err
	}
	path := fmt.Sprintf("/Users/%s/Items?IncludeItemTypes=Series&Recursive=true&SortBy=SortName&SortOrder=Ascending&Fields=PrimaryImageAspectRatio,ImageTags",
		c.userID)
	var resp struct {
		Items []JFShow `json:"Items"`
	}
	if err := c.get(path, &resp); err != nil {
		return nil, err
	}
	return resp.Items, nil
}

func (c *jellyfinClient) GetEpisodes(showID string) ([]JFEpisode, error) {
	if err := c.EnsureUserID(); err != nil {
		return nil, err
	}
	path := fmt.Sprintf(
		"/Users/%s/Items?ParentId=%s&IncludeItemTypes=Episode&Recursive=true&SortBy=ParentIndexNumber,IndexNumber&SortOrder=Ascending&Fields=RunTimeTicks&Limit=10000",
		c.userID, showID,
	)
	var resp struct {
		Items []JFEpisode `json:"Items"`
	}
	if err := c.get(path, &resp); err != nil {
		return nil, err
	}
	return resp.Items, nil
}

// cableBoxProfile is the Jellyfin device profile sent in PlaybackInfo requests.
// Video copy is allowed so Jellyfin only needs to transcode the audio track (AC3/DTS → AAC).
// Remuxing video is near-instant; full video re-encoding is what caused slow HLS startup.
// AllowAudioStreamCopy is false to ensure browsers always receive AAC regardless of source codec.
var cableBoxProfile = map[string]any{
	"MaxStreamingBitrate":  140_000_000,
	"DirectPlayProfiles":   []any{},
	"DirectStreamProfiles": []any{},
	"TranscodingProfiles": []map[string]any{{
		"Type":                 "Video",
		"Container":            "ts",
		"VideoCodec":           "h264,hevc,av1",
		"AudioCodec":           "aac,mp3,opus",
		"Protocol":             "hls",
		"Context":              "Streaming",
		"AllowVideoStreamCopy": true,
		"AllowAudioStreamCopy": false,
	}},
	"ContainerProfiles": []any{},
	"CodecProfiles":     []any{},
	"ResponseProfiles":  []any{},
}

type playbackInfoResp struct {
	MediaSources []struct {
		TranscodingUrl       string `json:"TranscodingUrl"`
		DirectStreamUrl      string `json:"DirectStreamUrl"`
		SupportsTranscoding  bool   `json:"SupportsTranscoding"`
		SupportsDirectStream bool   `json:"SupportsDirectStream"`
	} `json:"MediaSources"`
}

// GetTranscodeURL calls Jellyfin's PlaybackInfo API to get a proper transcoding URL
// that honours StartTimeTicks. Returns a URL rooted at c.baseURL.
func (c *jellyfinClient) GetTranscodeURL(itemID string, startTimeTicks int64) (string, error) {
	if c.userID == "" {
		if err := c.EnsureUserID(); err != nil {
			return "", err
		}
	}
	endpoint := fmt.Sprintf(
		"%s/Items/%s/PlaybackInfo?userId=%s&isPlayback=true&startTimeTicks=%d&autoOpenLiveStream=true",
		strings.TrimRight(c.baseURL, "/"), itemID, c.userID, startTimeTicks,
	)
	// Use a DeviceId that encodes the item and start position (seconds granularity) so Jellyfin
	// always opens a fresh transcoding session at the right offset instead of reusing a cached
	// session from a different position.
	deviceID := fmt.Sprintf("cb-%s-%d", itemID, startTimeTicks/10_000_000)

	body, _ := json.Marshal(map[string]any{
		"DeviceProfile":        cableBoxProfile,
		"StartTimeTicks":       startTimeTicks,
		"EnableDirectPlay":     false,
		"EnableDirectStream":   false,
		"EnableTranscoding":    true,
		"AllowVideoStreamCopy": true,
		"AllowAudioStreamCopy": false,
	})
	req, err := http.NewRequest("POST", endpoint, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Emby-Authorization", fmt.Sprintf(
		`MediaBrowser Client="CableBox", Device="CableBox", DeviceId="%s", Version="1.0.0", Token="%s"`,
		deviceID, c.apiKey))

	resp, err := jellyfinHTTPClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	var info playbackInfoResp
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil || len(info.MediaSources) == 0 {
		return "", fmt.Errorf("no media sources in PlaybackInfo response")
	}

	src := info.MediaSources[0]
	base := strings.TrimRight(c.baseURL, "/")

	if src.SupportsTranscoding && src.TranscodingUrl != "" {
		url := src.TranscodingUrl
		if !strings.HasPrefix(url, "http") {
			url = base + url
		}
		return url, nil
	}
	if src.DirectStreamUrl != "" {
		url := src.DirectStreamUrl
		if !strings.HasPrefix(url, "http") {
			url = base + url
		}
		return url, nil
	}
	return "", fmt.Errorf("no valid stream URL in PlaybackInfo response")
}

type JFMovie struct {
	Id           string            `json:"Id"`
	Name         string            `json:"Name"`
	RunTimeTicks int64             `json:"RunTimeTicks"`
	ImageTags    map[string]string `json:"ImageTags"`
}

type JFBrowseItem struct {
	Id             string            `json:"Id"`
	Name           string            `json:"Name"`
	Type           string            `json:"Type"`
	CollectionType string            `json:"CollectionType"`
	RunTimeTicks   int64             `json:"RunTimeTicks"`
	ImageTags      map[string]string `json:"ImageTags"`
	ThumbURL       string            `json:"thumbUrl,omitempty"`
}

// videosLibraryID finds the Jellyfin library with CollectionType "videos" and returns its ID.
// Returns "" if no such library exists.
func (c *jellyfinClient) videosLibraryID() string {
	if err := c.EnsureUserID(); err != nil {
		return ""
	}
	var resp struct {
		Items []JFBrowseItem `json:"Items"`
	}
	if err := c.get(fmt.Sprintf("/Users/%s/Views", c.userID), &resp); err != nil {
		return ""
	}
	for _, item := range resp.Items {
		if strings.EqualFold(item.CollectionType, "videos") {
			return item.Id
		}
	}
	return ""
}

// BrowseItems returns top-level library views (parentId="") or direct children of a folder.
func (c *jellyfinClient) BrowseItems(parentId string) ([]JFBrowseItem, error) {
	if err := c.EnsureUserID(); err != nil {
		return nil, err
	}
	var path string
	if parentId == "" {
		path = fmt.Sprintf("/Users/%s/Views", c.userID)
	} else {
		path = fmt.Sprintf(
			"/Users/%s/Items?ParentId=%s&SortBy=SortName&SortOrder=Ascending&Fields=RunTimeTicks,ImageTags",
			c.userID, parentId,
		)
	}
	var resp struct {
		Items []JFBrowseItem `json:"Items"`
	}
	if err := c.get(path, &resp); err != nil {
		return nil, err
	}
	return resp.Items, nil
}

func (c *jellyfinClient) GetMovies() ([]JFMovie, error) {
	if err := c.EnsureUserID(); err != nil {
		return nil, err
	}
	path := fmt.Sprintf("/Users/%s/Items?IncludeItemTypes=Movie&Recursive=true&SortBy=SortName&SortOrder=Ascending&Fields=RunTimeTicks,ImageTags",
		c.userID)
	var resp struct {
		Items []JFMovie `json:"Items"`
	}
	if err := c.get(path, &resp); err != nil {
		return nil, err
	}
	return resp.Items, nil
}

// Handler methods for library API

func (h *Handler) GetShows(w http.ResponseWriter, r *http.Request) {
	jfURL, _ := h.DB.GetConfig("jellyfin_url")
	jfKey, _ := h.DB.GetConfig("jellyfin_api_key")
	jfUser, _ := h.DB.GetConfig("jellyfin_user_id")

	if jfURL == "" {
		writeError(w, "jellyfin not configured", http.StatusServiceUnavailable)
		return
	}

	client := &jellyfinClient{baseURL: jfURL, apiKey: jfKey, userID: jfUser}
	shows, err := client.GetShows()
	if err != nil {
		writeError(w, "jellyfin error: "+err.Error(), http.StatusBadGateway)
		return
	}

	// If we got a userID from auto-discovery, persist it
	if jfUser == "" && client.userID != "" {
		h.DB.SetConfig("jellyfin_user_id", client.userID)
	}

	jfPublicURL, _ := h.DB.GetConfig("jellyfin_public_url")
	if jfPublicURL == "" {
		jfPublicURL = jfURL
	}

	// Enrich with thumbnail URLs using public URL (browser-accessible)
	type ShowWithThumb struct {
		JFShow
		ThumbURL string `json:"thumbUrl"`
	}
	result := make([]ShowWithThumb, len(shows))
	for i, s := range shows {
		result[i] = ShowWithThumb{JFShow: s}
		if tag, ok := s.ImageTags["Primary"]; ok {
			result[i].ThumbURL = fmt.Sprintf("%s/Items/%s/Images/Primary?api_key=%s&tag=%s&maxHeight=200",
				strings.TrimRight(jfPublicURL, "/"), s.Id, jfKey, tag)
		}
	}

	writeJSON(w, result)
}

func (h *Handler) GetEpisodes(w http.ResponseWriter, r *http.Request) {
	showID := r.PathValue("showId")
	if showID == "" {
		writeID := r.URL.Query().Get("showId")
		showID = writeID
	}

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

func (h *Handler) GetMovies(w http.ResponseWriter, r *http.Request) {
	jfURL, _ := h.DB.GetConfig("jellyfin_url")
	jfKey, _ := h.DB.GetConfig("jellyfin_api_key")
	jfUser, _ := h.DB.GetConfig("jellyfin_user_id")
	jfPublicURL, _ := h.DB.GetConfig("jellyfin_public_url")
	if jfPublicURL == "" {
		jfPublicURL = jfURL
	}

	if jfURL == "" {
		writeError(w, "jellyfin not configured", http.StatusServiceUnavailable)
		return
	}

	client := &jellyfinClient{baseURL: jfURL, apiKey: jfKey, userID: jfUser}
	movies, err := client.GetMovies()
	if err != nil {
		writeError(w, "jellyfin error: "+err.Error(), http.StatusBadGateway)
		return
	}

	type MovieWithThumb struct {
		JFMovie
		ThumbURL string `json:"thumbUrl"`
	}
	result := make([]MovieWithThumb, len(movies))
	for i, m := range movies {
		result[i] = MovieWithThumb{JFMovie: m}
		if tag, ok := m.ImageTags["Primary"]; ok {
			result[i].ThumbURL = fmt.Sprintf("%s/Items/%s/Images/Primary?api_key=%s&tag=%s&maxHeight=200",
				strings.TrimRight(jfPublicURL, "/"), m.Id, jfKey, tag)
		}
	}

	writeJSON(w, result)
}

func (h *Handler) BrowseVideos(w http.ResponseWriter, r *http.Request) {
	parentId := r.URL.Query().Get("parentId")

	jfURL, _ := h.DB.GetConfig("jellyfin_url")
	jfKey, _ := h.DB.GetConfig("jellyfin_api_key")
	jfUser, _ := h.DB.GetConfig("jellyfin_user_id")
	jfPublicURL, _ := h.DB.GetConfig("jellyfin_public_url")
	if jfPublicURL == "" {
		jfPublicURL = jfURL
	}

	if jfURL == "" {
		writeError(w, "jellyfin not configured", http.StatusServiceUnavailable)
		return
	}

	client := &jellyfinClient{baseURL: jfURL, apiKey: jfKey, userID: jfUser}

	// When no parentId is given, find the "videos" library and browse into it directly
	// so the tab shows video files rather than all Jellyfin library views.
	if parentId == "" {
		if id := client.videosLibraryID(); id != "" {
			parentId = id
		}
	}

	items, err := client.BrowseItems(parentId)
	if err != nil {
		writeError(w, "jellyfin error: "+err.Error(), http.StatusBadGateway)
		return
	}

	for i, item := range items {
		if tag, ok := item.ImageTags["Primary"]; ok {
			items[i].ThumbURL = fmt.Sprintf("%s/Items/%s/Images/Primary?api_key=%s&tag=%s&maxHeight=200",
				strings.TrimRight(jfPublicURL, "/"), item.Id, jfKey, tag)
		}
	}

	writeJSON(w, items)
}

// TestJellyfin checks the connection and returns the first user found.
func (h *Handler) TestJellyfin(w http.ResponseWriter, r *http.Request) {
	jfURL, _ := h.DB.GetConfig("jellyfin_url")
	jfKey, _ := h.DB.GetConfig("jellyfin_api_key")

	if jfURL == "" {
		writeError(w, "jellyfin not configured", http.StatusServiceUnavailable)
		return
	}

	client := &jellyfinClient{baseURL: jfURL, apiKey: jfKey}
	if err := client.EnsureUserID(); err != nil {
		writeError(w, err.Error(), http.StatusBadGateway)
		return
	}

	// Save discovered user ID
	h.DB.SetConfig("jellyfin_user_id", client.userID)

	writeJSON(w, map[string]string{"userId": client.userID, "status": "ok"})
}
