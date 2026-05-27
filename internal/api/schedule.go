package api

import (
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"io"
	"math/rand"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

// streamProxyClient has no timeout — the connection stays open for the duration of video playback.
// Cancellation is handled via the request context (closed when the client disconnects).
var streamProxyClient = &http.Client{Timeout: 0}

type ScheduleBlock struct {
	ID              int64  `json:"id"`
	ChannelID       int64  `json:"channelId"`
	StartTime       string `json:"startTime"`
	DurationSeconds int    `json:"durationSeconds"`
	Type            string `json:"type"`
	JellyfinItemID  string `json:"jellyfinItemId"`
	ShowID          string `json:"showId"`
	ShowName        string `json:"showName"`
	EpisodeName     string `json:"episodeName"`
	SeasonNumber    int    `json:"seasonNumber"`
	EpisodeNumber   int    `json:"episodeNumber"`
	EmptyImageURL   string `json:"emptyImageUrl"`
	IsRecurring     bool   `json:"isRecurring"`
	RecurDays       string `json:"recurDays"`
	GroupID         string `json:"groupId"`
}

type ExpandedBlock struct {
	ScheduleBlock
	ComputedStart   string   `json:"computedStart"`
	ComputedEnd     string   `json:"computedEnd"`
	ChannelNumber   int      `json:"channelNumber"`
	ChannelName     string   `json:"channelName"`
	ThumbURL        string   `json:"thumbUrl,omitempty"`
	SkippedEpisodes []string `json:"skippedEpisodes,omitempty"`
	// SeasonFilter preserves the stored season filter before SeasonNumber is overwritten
	// with the resolved episode's season for guide display.
	SeasonFilter     int              `json:"seasonFilter"`
	// EpisodeDurations lets the frontend recompute skipped-episode warnings live during resize.
	EpisodeDurations []EpisodeDuration `json:"episodeDurations,omitempty"`
}

type EpisodeDuration struct {
	Name    string `json:"name"`
	Seconds int64  `json:"seconds"`
}

type NextInfo struct {
	Title           string `json:"title"`
	StartTime       string `json:"startTime"`
	DurationSeconds int64  `json:"durationSeconds"`
	ThumbURL        string `json:"thumbUrl,omitempty"`
	BackdropURL     string `json:"backdropUrl,omitempty"`
	Type            string `json:"type"`
}

type NowPlayingInfo struct {
	Type            string `json:"type"`
	StreamURL       string `json:"streamUrl,omitempty"`
	// PlaybackKey changes whenever a different video should load (blockId for episode,
	// blockId+episodeId for random — lets the player detect episode transitions mid-block).
	PlaybackKey             string    `json:"playbackKey,omitempty"`
	Title                   string    `json:"title,omitempty"`
	DurationSeconds         int       `json:"durationSeconds,omitempty"`
	EpisodeDurationSeconds  int64     `json:"episodeDurationSeconds,omitempty"`
	PositionSeconds         int64     `json:"positionSeconds,omitempty"`
	StartTime               string    `json:"startTime,omitempty"`
	EndTime                 string    `json:"endTime,omitempty"`
	SeasonNumber            int       `json:"seasonNumber,omitempty"`
	EpisodeNumber           int       `json:"episodeNumber,omitempty"`
	EmptyImageURL           string    `json:"emptyImageUrl,omitempty"`
	BlockID                 int64     `json:"blockId,omitempty"`
	Next                    *NextInfo `json:"next,omitempty"`
}

// GetSchedule returns expanded blocks for a time range.
// Query params: from (ISO8601), to (ISO8601), channel (optional id)
func (h *Handler) GetSchedule(w http.ResponseWriter, r *http.Request) {
	fromStr := r.URL.Query().Get("from")
	toStr := r.URL.Query().Get("to")
	channelStr := r.URL.Query().Get("channel")

	from := time.Now().UTC().Add(-4 * time.Hour)
	to := time.Now().UTC().Add(24 * time.Hour)

	// Accept both RFC3339 ("Z") and RFC3339Nano (".000Z") — JS toISOString() includes milliseconds.
	parseTime := func(s string) (time.Time, bool) {
		if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
			return t.UTC(), true
		}
		if t, err := time.Parse(time.RFC3339, s); err == nil {
			return t.UTC(), true
		}
		return time.Time{}, false
	}
	if fromStr != "" {
		if t, ok := parseTime(fromStr); ok {
			from = t
		}
	}
	if toStr != "" {
		if t, ok := parseTime(toStr); ok {
			to = t
		}
	}

	channelID := int64(0)
	if channelStr != "" {
		channelID, _ = strconv.ParseInt(channelStr, 10, 64)
	}

	blocks, err := h.expandedBlocksForRange(from, to, channelID)
	if err != nil {
		writeError(w, "db error", http.StatusInternalServerError)
		return
	}

	// Attach thumbnail URLs and resolve random-block episodes.
	jfPublicURL, _ := h.DB.GetConfig("jellyfin_public_url")
	jfInternalURL, _ := h.DB.GetConfig("jellyfin_url")
	jfKey, _ := h.DB.GetConfig("jellyfin_api_key")
	jfUserID, _ := h.DB.GetConfig("jellyfin_user_id")
	if jfPublicURL == "" {
		jfPublicURL = jfInternalURL
	}

	thumbURL := func(itemID string) string {
		if jfPublicURL == "" || jfKey == "" || itemID == "" {
			return ""
		}
		// fillWidth/fillHeight asks Jellyfin to crop server-side, eliminating letterboxing.
		return fmt.Sprintf("%s/Items/%s/Images/Primary?api_key=%s&fillWidth=80&fillHeight=124",
			strings.TrimRight(jfPublicURL, "/"), itemID, jfKey)
	}

	// First pass: attach thumbnails for episode-type blocks and compute EpisodeDurations
	// (used by the scheduler resize tooltip). Random/sequential blocks are expanded below.
	for i := range blocks {
		switch blocks[i].Type {
		case "episode":
			blocks[i].ThumbURL = thumbURL(blocks[i].JellyfinItemID)

		case "random", "sequential":
			if blocks[i].ShowID == "" {
				break
			}
			allEps := h.cachedEpisodes(blocks[i].ShowID, jfInternalURL, jfKey, jfUserID)
			blockDur := int64(blocks[i].DurationSeconds)
			seasonFilter := blocks[i].SeasonFilter
			for _, ep := range allEps {
				if seasonFilter > 0 && ep.ParentIndexNumber != seasonFilter {
					continue
				}
				epDur := ep.RunTimeTicks / 10_000_000
				if epDur <= 0 {
					continue
				}
				label := ep.Name
				if ep.ParentIndexNumber > 0 && ep.IndexNumber > 0 {
					label = fmt.Sprintf("S%02dE%02d – %s", ep.ParentIndexNumber, ep.IndexNumber, ep.Name)
				}
				blocks[i].EpisodeDurations = append(blocks[i].EpisodeDurations, EpisodeDuration{
					Name: label, Seconds: epDur,
				})
				if epDur > blockDur {
					blocks[i].SkippedEpisodes = append(blocks[i].SkippedEpisodes, label)
				}
			}
		}
	}

	// Second pass: expand random/sequential blocks into one ExpandedBlock per episode
	// so the TV Guide shows individual episode slots with correct times.
	// Only performed when ?expand=true is set (TV Guide); the scheduler omits this param
	// so it continues to see one block per schedule entry.
	if r.URL.Query().Get("expand") != "true" {
		writeJSON(w, blocks)
		return
	}
	result := make([]ExpandedBlock, 0, len(blocks))
	for _, b := range blocks {
		if b.Type != "random" && b.Type != "sequential" {
			result = append(result, b)
			continue
		}
		if b.ShowID == "" {
			result = append(result, b)
			continue
		}

		blockStart, err := time.Parse(time.RFC3339, b.ComputedStart)
		if err != nil {
			result = append(result, b)
			continue
		}

		episodes := h.cachedEpisodes(b.ShowID, jfInternalURL, jfKey, jfUserID)
		seasonFilter := b.SeasonFilter
		if seasonFilter > 0 {
			filtered := make([]JFEpisode, 0, len(episodes))
			for _, ep := range episodes {
				if ep.ParentIndexNumber == seasonFilter {
					filtered = append(filtered, ep)
				}
			}
			episodes = filtered
		}
		if len(episodes) == 0 {
			result = append(result, b)
			continue
		}

		sequential := b.Type == "sequential"
		blockDur := int64(b.DurationSeconds)
		// Start the guide expansion at the global offset so the TV Guide matches playback
		priorSec := h.priorRunSeconds(b.ChannelID, blockStart, b.ShowID, b.Type, b.SeasonFilter)
		globalAccum := int64(0)
		accumulated := int64(0)
		anyAdded := false

	cycleLoop:
		for cycle := range 200 {
			cycleEps := episodesForCycle(episodes, b.ChannelID, b.ShowID, cycle, sequential)
			for _, ep := range cycleEps {
				epDur := ep.RunTimeTicks / 10_000_000
				if epDur <= 0 {
					epDur = 1800
				}
				// globalAccum tracks position across all cycles from the show's beginning.
				// Episodes that fall entirely before this block (prior run) are skipped.
				// Episodes that span the block boundary are clamped to the block window.
				globalEnd := globalAccum + epDur

				if globalEnd <= priorSec {
					// Entirely in a prior block — skip
					globalAccum = globalEnd
					continue
				}

				// Where this ep sits within this block [0, blockDur]
				slotStart := max(globalAccum-priorSec, 0)
				slotEnd := min(globalEnd-priorSec, blockDur)
				slotDur := slotEnd - slotStart

				if slotStart >= blockDur {
					break cycleLoop
				}

				if slotDur > 2 {
					child := b
					epStart := blockStart.Add(time.Duration(slotStart) * time.Second)
					child.ComputedStart = epStart.Format(time.RFC3339)
					child.ComputedEnd = epStart.Add(time.Duration(slotDur) * time.Second).Format(time.RFC3339)
					child.DurationSeconds = int(slotDur)
					child.EpisodeName = ep.Name
					child.SeasonNumber = ep.ParentIndexNumber
					child.EpisodeNumber = ep.IndexNumber
					child.JellyfinItemID = ep.Id
					child.ThumbURL = thumbURL(ep.Id)
					child.EpisodeDurations = nil
					child.SkippedEpisodes = nil
					result = append(result, child)
					anyAdded = true
				}

				globalAccum = globalEnd
				accumulated = slotEnd
				if accumulated >= blockDur {
					break cycleLoop
				}
			}
		}

		if !anyAdded {
			result = append(result, b)
		}
	}

	writeJSON(w, result)
}

func (h *Handler) expandedBlocksForRange(from, to time.Time, channelID int64) ([]ExpandedBlock, error) {
	channelFilter := ""
	args := []any{from.Format(time.RFC3339), to.Format(time.RFC3339)}
	if channelID > 0 {
		channelFilter = "AND sb.channel_id = ?"
		args = append(args, channelID)
	}

	// One-time blocks overlapping [from, to]
	// Wrap both sides in datetime() so output format matches ("YYYY-MM-DD HH:MM:SS" vs RFC3339 "T"/"Z")
	query := fmt.Sprintf(`
		SELECT sb.id, sb.channel_id, sb.start_time, sb.duration_seconds,
		       sb.type, sb.jellyfin_item_id, sb.show_id, sb.show_name,
		       sb.episode_name, sb.season_number, sb.episode_number,
		       sb.empty_image_url, sb.is_recurring, sb.recur_days,
		       ch.number, ch.name, sb.group_id
		FROM schedule_blocks sb
		JOIN channels ch ON ch.id = sb.channel_id
		WHERE sb.is_recurring = 0
		  AND datetime(sb.start_time, '+' || sb.duration_seconds || ' seconds') > datetime(?)
		  AND datetime(sb.start_time) < datetime(?)
		  %s
		ORDER BY sb.start_time`, channelFilter)

	rows, err := h.DB.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := []ExpandedBlock{}
	for rows.Next() {
		eb, err := scanExpandedBlock(rows)
		if err != nil {
			return nil, err
		}
		// Parse start time and compute end — try RFC3339Nano first because
		// JS toISOString() includes milliseconds (e.g. "...T20:00:00.000Z").
		if t, err := time.Parse(time.RFC3339Nano, eb.StartTime); err == nil {
			eb.ComputedStart = t.UTC().Format(time.RFC3339)
			eb.ComputedEnd = t.UTC().Add(time.Duration(eb.DurationSeconds) * time.Second).Format(time.RFC3339)
		} else if t, err := time.Parse(time.RFC3339, eb.StartTime); err == nil {
			eb.ComputedStart = t.UTC().Format(time.RFC3339)
			eb.ComputedEnd = t.UTC().Add(time.Duration(eb.DurationSeconds) * time.Second).Format(time.RFC3339)
		}
		result = append(result, eb)
	}
	rows.Close()

	// Recurring blocks
	recurArgs := []any{}
	recurFilter := ""
	if channelID > 0 {
		recurFilter = "WHERE sb.channel_id = ? AND sb.is_recurring = 1"
		recurArgs = append(recurArgs, channelID)
	} else {
		recurFilter = "WHERE sb.is_recurring = 1"
	}

	recurQuery := fmt.Sprintf(`
		SELECT sb.id, sb.channel_id, sb.start_time, sb.duration_seconds,
		       sb.type, sb.jellyfin_item_id, sb.show_id, sb.show_name,
		       sb.episode_name, sb.season_number, sb.episode_number,
		       sb.empty_image_url, sb.is_recurring, sb.recur_days,
		       ch.number, ch.name, sb.group_id
		FROM schedule_blocks sb
		JOIN channels ch ON ch.id = sb.channel_id
		%s`, recurFilter)

	recurRows, err := h.DB.Query(recurQuery, recurArgs...)
	if err != nil {
		return nil, err
	}
	defer recurRows.Close()

	for recurRows.Next() {
		block, err := scanExpandedBlock(recurRows)
		if err != nil {
			return nil, err
		}

		// Expand this recurring block for each day in [from, to]
		var days []int
		if err := json.Unmarshal([]byte(block.RecurDays), &days); err != nil || len(days) == 0 {
			continue
		}

		daySet := make(map[int]bool)
		for _, d := range days {
			daySet[d] = true
		}

		// Parse time-of-day from start_time ("HH:MM:SS" or "15:04:05")
		var blockHour, blockMin, blockSec int
		fmt.Sscanf(block.StartTime, "%d:%d:%d", &blockHour, &blockMin, &blockSec)
		dur := time.Duration(block.DurationSeconds) * time.Second

		// Start one day before `from` so a block that started yesterday and
		// is still running (e.g. a 24-hour block at 06:00 when it's now 05:00)
		// is included — mirrors the "today and yesterday" logic in findLiveBlock.
		start := from.Truncate(24 * time.Hour).AddDate(0, 0, -1)
		for d := start; d.Before(to.Add(24 * time.Hour)); d = d.AddDate(0, 0, 1) {
			if !daySet[int(d.Weekday())] {
				continue
			}
			blockStart := time.Date(d.Year(), d.Month(), d.Day(), blockHour, blockMin, blockSec, 0, time.UTC)
			blockEnd := blockStart.Add(dur)
			if blockStart.Before(to) && blockEnd.After(from) {
				eb := block
				eb.ComputedStart = blockStart.Format(time.RFC3339)
				eb.ComputedEnd = blockEnd.Format(time.RFC3339)
				result = append(result, eb)
			}
		}
	}

	return result, nil
}

func scanExpandedBlock(rows *sql.Rows) (ExpandedBlock, error) {
	var eb ExpandedBlock
	var isRecurring int
	err := rows.Scan(
		&eb.ID, &eb.ChannelID, &eb.StartTime, &eb.DurationSeconds,
		&eb.Type, &eb.JellyfinItemID, &eb.ShowID, &eb.ShowName,
		&eb.EpisodeName, &eb.SeasonNumber, &eb.EpisodeNumber,
		&eb.EmptyImageURL, &isRecurring, &eb.RecurDays,
		&eb.ChannelNumber, &eb.ChannelName, &eb.GroupID,
	)
	eb.IsRecurring = isRecurring != 0
	eb.SeasonFilter = eb.SeasonNumber // preserve the stored season filter before any overwrite
	return eb, err
}

// GetNow returns the currently airing content for every channel.
func (h *Handler) GetNow(w http.ResponseWriter, r *http.Request) {
	now := time.Now().UTC()

	jfInternalURL, _ := h.DB.GetConfig("jellyfin_url")
	jfKey, _ := h.DB.GetConfig("jellyfin_api_key")
	jfPublicURL, _ := h.DB.GetConfig("jellyfin_public_url")
	jfUserID, _ := h.DB.GetConfig("jellyfin_user_id")
	if jfPublicURL == "" {
		jfPublicURL = jfInternalURL
	}

	// Fetch all channels — close before any per-channel queries
	chRows, err := h.DB.Query("SELECT id, number FROM channels ORDER BY number")
	if err != nil {
		writeError(w, "db error", http.StatusInternalServerError)
		return
	}
	type chanInfo struct {
		id     int64
		number int
	}
	var channels []chanInfo
	for chRows.Next() {
		var ci chanInfo
		if err := chRows.Scan(&ci.id, &ci.number); err != nil {
			continue
		}
		channels = append(channels, ci)
	}
	chRows.Close()

	result := make(map[int]NowPlayingInfo)
	for _, ch := range channels {
		info := h.findLiveBlock(now, ch.id, jfInternalURL, jfPublicURL, jfKey, jfUserID)
		if info.StreamURL == "" && info.Type != "empty" {
			// Nothing playing (off air or gap inside a block) — find what's up next.
			lookAfter := now
			if info.EndTime != "" {
				if t, err := time.Parse(time.RFC3339, info.EndTime); err == nil {
					lookAfter = t
				}
			}
			info.Next = h.findNextBlockInfo(lookAfter, ch.id, jfPublicURL, jfKey)
		}
		result[ch.number] = info
	}

	writeJSON(w, result)
}

func (h *Handler) findLiveBlock(now time.Time, channelID int64, jfInternalURL, jfPublicURL, jfKey, jfUserID string) NowPlayingInfo {
	type blockRow struct {
		id, durSec             int64
		startStr, blockType    string
		jfID, showID           string
		showName, epName       string
		seasonNum, epNum       int
		emptyImg               string
	}

	// Check one-time blocks — scan everything first, then close rows before any other DB call.
	var oneTime *blockRow
	rows, err := h.DB.Query(`
		SELECT id, start_time, duration_seconds, type, jellyfin_item_id,
		       show_id, show_name, episode_name, season_number, episode_number, empty_image_url
		FROM schedule_blocks
		WHERE channel_id = ? AND is_recurring = 0
		  AND datetime(start_time) <= datetime(?) AND datetime(start_time, '+' || duration_seconds || ' seconds') > datetime(?)
		LIMIT 1`,
		channelID,
		now.Format(time.RFC3339),
		now.Format(time.RFC3339),
	)
	if err == nil {
		if rows.Next() {
			b := &blockRow{}
			rows.Scan(&b.id, &b.startStr, &b.durSec, &b.blockType, &b.jfID,
				&b.showID, &b.showName, &b.epName, &b.seasonNum, &b.epNum, &b.emptyImg)
			oneTime = b
		}
		rows.Close() // close before any further DB calls
	}

	if oneTime != nil {
		blockStart, err := time.Parse(time.RFC3339Nano, oneTime.startStr)
		if err != nil {
			blockStart, err = time.Parse(time.RFC3339, oneTime.startStr)
		}
		if err == nil {
			blockEnd := blockStart.Add(time.Duration(oneTime.durSec) * time.Second)
			pos := int64(now.Sub(blockStart).Seconds())
			return h.buildNowPlaying(oneTime.id, channelID, blockStart, blockEnd,
				oneTime.blockType, oneTime.jfID, oneTime.showID,
				oneTime.showName, oneTime.epName, oneTime.seasonNum, oneTime.epNum,
				oneTime.emptyImg, pos, oneTime.durSec, jfInternalURL, jfPublicURL, jfKey, jfUserID)
		}
	}

	// Check recurring blocks — include recur_days in the query to avoid a second query per row.
	type recurRow struct {
		blockRow
		recurDays string
	}
	recurRows, err := h.DB.Query(`
		SELECT id, start_time, duration_seconds, type, jellyfin_item_id,
		       show_id, show_name, episode_name, season_number, episode_number, empty_image_url,
		       recur_days
		FROM schedule_blocks
		WHERE channel_id = ? AND is_recurring = 1`,
		channelID,
	)
	if err != nil {
		return NowPlayingInfo{Type: "off"}
	}
	var recurBlocks []recurRow
	for recurRows.Next() {
		var rb recurRow
		recurRows.Scan(&rb.id, &rb.startStr, &rb.durSec, &rb.blockType, &rb.jfID,
			&rb.showID, &rb.showName, &rb.epName, &rb.seasonNum, &rb.epNum, &rb.emptyImg,
			&rb.recurDays)
		recurBlocks = append(recurBlocks, rb)
	}
	recurRows.Close() // close before any further DB calls

	for _, rb := range recurBlocks {
		var bH, bM, bS int
		fmt.Sscanf(rb.startStr, "%d:%d:%d", &bH, &bM, &bS)

		var days []int
		json.Unmarshal([]byte(rb.recurDays), &days)
		if len(days) == 0 {
			continue
		}
		daySet := make(map[int]bool)
		for _, d := range days {
			daySet[d] = true
		}

		// Check today and yesterday — a block that started yesterday may still be running now
		// (e.g. a 24-hour block starting at 06:00 UTC is still live at 02:55 UTC the next day).
		for _, offset := range []int{0, -1} {
			candidate := now.AddDate(0, 0, offset)
			blockStart := time.Date(candidate.Year(), candidate.Month(), candidate.Day(), bH, bM, bS, 0, time.UTC)
			blockEnd := blockStart.Add(time.Duration(rb.durSec) * time.Second)

			if blockStart.After(now) || !now.Before(blockEnd) {
				continue
			}
			if !daySet[int(blockStart.Weekday())] {
				continue
			}

			pos := int64(now.Sub(blockStart).Seconds())
			return h.buildNowPlaying(rb.id, channelID, blockStart, blockEnd,
				rb.blockType, rb.jfID, rb.showID,
				rb.showName, rb.epName, rb.seasonNum, rb.epNum,
				rb.emptyImg, pos, rb.durSec, jfInternalURL, jfPublicURL, jfKey, jfUserID)
		}
	}

	return NowPlayingInfo{Type: "off"}
}

func (h *Handler) buildNowPlaying(
	blockID, channelID int64,
	blockStart, blockEnd time.Time,
	blockType, jfID, showID, showName, epName string,
	seasonNum, epNum int,
	emptyImg string,
	positionSeconds, durationSeconds int64,
	jfInternalURL, jfPublicURL, jfKey, jfUserID string,
) NowPlayingInfo {
	info := NowPlayingInfo{
		Type:            blockType,
		DurationSeconds: int(durationSeconds),
		PositionSeconds: positionSeconds,
		StartTime:       blockStart.Format(time.RFC3339),
		EndTime:         blockEnd.Format(time.RFC3339),
		BlockID:         blockID,
	}

	switch blockType {
	case "episode":
		info.StreamURL = fmt.Sprintf("/api/stream-file?itemId=%s", jfID)
		info.PlaybackKey = fmt.Sprintf("%d", blockID)
		title := showName
		if epName != "" {
			title = showName + " - " + epName
		}
		if seasonNum > 0 && epNum > 0 {
			title = fmt.Sprintf("%s - S%02dE%02d - %s", showName, seasonNum, epNum, epName)
		}
		info.Title = title
		info.SeasonNumber = seasonNum
		info.EpisodeNumber = epNum
		info.EpisodeDurationSeconds = int64(durationSeconds)

	case "random", "sequential":
		prior := h.priorRunSeconds(channelID, blockStart, showID, blockType, seasonNum)
		globalPos := prior + positionSeconds
		ep, epOffset := h.findEpisodeAtPosition(channelID, globalPos, showID, seasonNum, blockType == "sequential", jfInternalURL, jfKey, jfUserID)
		if ep != nil {
			info.StreamURL = fmt.Sprintf("/api/stream-file?itemId=%s", ep.Id)
			info.PlaybackKey = fmt.Sprintf("%d-%s", blockID, ep.Id)
			info.Title = fmt.Sprintf("%s - S%02dE%02d - %s", showName, ep.ParentIndexNumber, ep.IndexNumber, ep.Name)
			info.SeasonNumber = ep.ParentIndexNumber
			info.EpisodeNumber = ep.IndexNumber
			info.PositionSeconds = epOffset
			info.EpisodeDurationSeconds = ep.RunTimeTicks / 10_000_000
		}
		// ep == nil means we're in a gap — StreamURL stays empty → static

	case "empty":
		info.EmptyImageURL = emptyImg
	}

	return info
}

// episodesForCycle returns a deterministically shuffled copy of episodes for the given cycle.
// Seed is based on channelID+showID so all contiguous blocks of the same show on the same
// channel share an identical episode ordering — enabling seamless cross-block continuity.
// Each cycle uses a different seed so every pass through the list has a different order.
// Sequential blocks always return episodes in their original order.
func episodesForCycle(episodes []JFEpisode, channelID int64, showID string, cycle int, sequential bool) []JFEpisode {
	out := make([]JFEpisode, len(episodes))
	copy(out, episodes)
	if sequential {
		return out
	}
	seed := fmt.Sprintf("ch%d-%s-c%d", channelID, showID, cycle)
	hasher := fnv.New32a()
	hasher.Write([]byte(seed))
	rng := rand.New(rand.NewSource(int64(hasher.Sum32())))
	rng.Shuffle(len(out), func(a, b int) { out[a], out[b] = out[b], out[a] })
	return out
}

// priorRunSeconds returns the total duration of contiguous preceding blocks on the same channel
// that share the same showID, type, and seasonFilter. This lets findEpisodeAtPosition treat
// adjacent same-show blocks as one continuous run so episodes span block boundaries naturally.
func (h *Handler) priorRunSeconds(channelID int64, blockStart time.Time, showID, blockType string, seasonFilter int) int64 {
	total := int64(0)
	searchEnd := blockStart
	for range 60 { // limit lookback to 60 blocks
		dur := h.adjacentBlockEndingAt(channelID, searchEnd, showID, blockType, seasonFilter)
		if dur == 0 {
			break
		}
		total += dur
		searchEnd = searchEnd.Add(-time.Duration(dur) * time.Second)
	}
	return total
}

// adjacentBlockEndingAt returns the duration of a one-time or recurring block on channelID
// that ends at exactly endTime and matches the given show/type/season, or 0 if none found.
func (h *Handler) adjacentBlockEndingAt(channelID int64, endTime time.Time, showID, blockType string, seasonFilter int) int64 {
	// One-time blocks: check via Unix timestamp arithmetic in SQLite
	var dur int64
	err := h.DB.QueryRow(`
		SELECT duration_seconds FROM schedule_blocks
		WHERE channel_id=? AND show_id=? AND type=? AND season_number=? AND is_recurring=0
		  AND ABS(CAST(strftime('%s', start_time) AS INTEGER) + duration_seconds - ?) < 2
		LIMIT 1`,
		channelID, showID, blockType, seasonFilter, endTime.Unix(),
	).Scan(&dur)
	if err == nil {
		return dur
	}

	// Recurring blocks: find one whose occurrence would end at endTime
	rows, err := h.DB.Query(`
		SELECT start_time, duration_seconds, recur_days FROM schedule_blocks
		WHERE channel_id=? AND show_id=? AND type=? AND season_number=? AND is_recurring=1`,
		channelID, showID, blockType, seasonFilter,
	)
	if err != nil {
		return 0
	}
	defer rows.Close()
	for rows.Next() {
		var startStr string
		var blockDur int64
		var recurJSON string
		rows.Scan(&startStr, &blockDur, &recurJSON)
		var days []int
		json.Unmarshal([]byte(recurJSON), &days)
		if len(days) == 0 {
			continue
		}
		daySet := make(map[int]bool)
		for _, d := range days {
			daySet[d] = true
		}
		var bH, bM, bS int
		fmt.Sscanf(startStr, "%d:%d:%d", &bH, &bM, &bS)
		// If this block has duration blockDur, its occurrence starts at endTime - blockDur
		occStart := endTime.Add(-time.Duration(blockDur) * time.Second)
		if occStart.Hour() == bH && occStart.Minute() == bM && occStart.Second() == bS && daySet[int(occStart.Weekday())] {
			return blockDur
		}
	}
	return 0
}

// findEpisodeAtPosition returns the episode playing at globalPosition seconds into the show's
// run, and the offset within that episode. globalPosition should be the sum of all prior
// contiguous block durations plus the current position within the current block — this allows
// episodes to span block boundaries transparently.
// seasonFilter > 0 restricts to that season only.
// sequential plays episodes in order; otherwise uses a per-cycle deterministic shuffle.
func (h *Handler) findEpisodeAtPosition(
	channelID int64,
	globalPosition int64,
	showID string, seasonFilter int, sequential bool,
	jfURL, jfKey, userID string,
) (*JFEpisode, int64) {
	if showID == "" || jfURL == "" {
		return nil, 0
	}

	episodes := h.cachedEpisodes(showID, jfURL, jfKey, userID)
	if len(episodes) == 0 {
		return nil, 0
	}

	if seasonFilter > 0 {
		filtered := make([]JFEpisode, 0, len(episodes))
		for _, ep := range episodes {
			if ep.ParentIndexNumber == seasonFilter {
				filtered = append(filtered, ep)
			}
		}
		episodes = filtered
		if len(episodes) == 0 {
			return nil, 0
		}
	}

	accumulated := int64(0)
	for cycle := range 200 {
		for _, ep := range episodesForCycle(episodes, channelID, showID, cycle, sequential) {
			epDuration := ep.RunTimeTicks / 10_000_000
			if epDuration <= 0 {
				epDuration = 1800
			}
			if globalPosition < accumulated+epDuration {
				epCopy := ep
				return &epCopy, globalPosition - accumulated
			}
			accumulated += epDuration
		}
	}

	return nil, 0
}

// findNextBlockInfo returns info about the next scheduled block starting after `after` on the given channel.
func (h *Handler) findNextBlockInfo(after time.Time, channelID int64, jfPublicURL, jfKey string) *NextInfo {
	blocks, err := h.expandedBlocksForRange(after, after.Add(48*time.Hour), channelID)
	if err != nil {
		return nil
	}

	var next *ExpandedBlock
	for i := range blocks {
		b := &blocks[i]
		start, err := time.Parse(time.RFC3339, b.ComputedStart)
		if err != nil {
			continue
		}
		if !start.After(after) {
			continue
		}
		if next == nil {
			next = b
		} else {
			nextStart, _ := time.Parse(time.RFC3339, next.ComputedStart)
			if start.Before(nextStart) {
				next = b
			}
		}
	}

	if next == nil {
		return nil
	}

	base := strings.TrimRight(jfPublicURL, "/")

	thumbURL := func(itemID string) string {
		if base == "" || jfKey == "" || itemID == "" {
			return ""
		}
		return fmt.Sprintf("%s/Items/%s/Images/Primary?api_key=%s&fillWidth=200&fillHeight=300",
			base, itemID, jfKey)
	}
	backdropURL := func(itemID string) string {
		if base == "" || jfKey == "" || itemID == "" {
			return ""
		}
		return fmt.Sprintf("%s/Items/%s/Images/Backdrop?api_key=%s&fillWidth=1280",
			base, itemID, jfKey)
	}

	info := &NextInfo{
		Type:            next.Type,
		StartTime:       next.ComputedStart,
		DurationSeconds: int64(next.DurationSeconds),
	}

	switch next.Type {
	case "episode":
		title := next.ShowName
		if next.SeasonNumber > 0 && next.EpisodeNumber > 0 {
			title = fmt.Sprintf("%s - S%02dE%02d", next.ShowName, next.SeasonNumber, next.EpisodeNumber)
			if next.EpisodeName != "" {
				title += " - " + next.EpisodeName
			}
		} else if next.EpisodeName != "" {
			title = next.ShowName + " - " + next.EpisodeName
		}
		info.Title = title
		info.ThumbURL = thumbURL(next.JellyfinItemID)
		info.BackdropURL = backdropURL(next.ShowID)
	case "random", "sequential":
		info.Title = next.ShowName
		info.ThumbURL = thumbURL(next.ShowID)
		info.BackdropURL = backdropURL(next.ShowID)
	case "empty":
		info.Title = "Off Air"
		info.ThumbURL = next.EmptyImageURL
	}

	return info
}

func (h *Handler) cachedEpisodes(showID, jfURL, jfKey, userID string) []JFEpisode {
	h.epCacheMu.RLock()
	eps, ok := h.epCache[showID]
	fetchedAt := h.epCacheTime[showID]
	h.epCacheMu.RUnlock()

	if ok && time.Since(fetchedAt) < time.Hour {
		return eps
	}

	client := &jellyfinClient{baseURL: jfURL, apiKey: jfKey, userID: userID}

	fetched, err := client.GetEpisodes(showID)
	if err != nil {
		return eps
	}

	h.epCacheMu.Lock()
	h.epCache[showID] = fetched
	h.epCacheTime[showID] = time.Now()
	h.epCacheMu.Unlock()

	return fetched
}

// buildFallbackURL is used when PlaybackInfo is unavailable.
// Returns an HLS URL so HLS.js / native HLS can parse it (MP4 would break the HLS path).
func buildFallbackURL(jfURL, jfKey, itemID string, startTimeTicks int64) string {
	if jfURL == "" || itemID == "" {
		return ""
	}
	return fmt.Sprintf(
		"%s/Videos/%s/main.m3u8?api_key=%s&VideoCodec=h264,hevc,av1&AudioCodec=aac,mp3,opus&StartTimeTicks=%d&MediaSourceId=%s",
		strings.TrimRight(jfURL, "/"), itemID, jfKey, startTimeTicks, itemID,
	)
}

// StreamProxy fetches a Jellyfin HLS playlist server-side and rewrites all segment URLs to
// point back to /api/stream-segment. Mobile devices only need to reach cablebox — they never
// contact Jellyfin directly, bypassing Traefik auth-forward on cross-site requests.
func (h *Handler) StreamProxy(w http.ResponseWriter, r *http.Request) {
	itemID := r.URL.Query().Get("itemId")
	startTicks, _ := strconv.ParseInt(r.URL.Query().Get("startTicks"), 10, 64)

	jfURL, _ := h.DB.GetConfig("jellyfin_url")
	jfKey, _ := h.DB.GetConfig("jellyfin_api_key")

	if jfURL == "" || itemID == "" {
		http.Error(w, "not configured", http.StatusServiceUnavailable)
		return
	}

	jfUserID, _ := h.DB.GetConfig("jellyfin_user_id")

	client := &jellyfinClient{baseURL: jfURL, apiKey: jfKey, userID: jfUserID}
	streamURL, err := client.GetTranscodeURL(itemID, startTicks)
	if err != nil {
		streamURL = buildFallbackURL(jfURL, jfKey, itemID, startTicks)
	}
	if streamURL == "" {
		http.Error(w, "no stream available", http.StatusNotFound)
		return
	}

	proxyAndRewrite(w, r, streamURL)
}

// StreamSegment proxies a single HLS segment (or nested playlist) back to the client.
// The src query param must be a URL under the configured Jellyfin server.
func (h *Handler) StreamSegment(w http.ResponseWriter, r *http.Request) {
	src := r.URL.Query().Get("src")
	if src == "" {
		http.Error(w, "missing src", http.StatusBadRequest)
		return
	}
	jfURL, _ := h.DB.GetConfig("jellyfin_url")
	if jfURL == "" || !strings.HasPrefix(src, strings.TrimRight(jfURL, "/")) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	proxyAndRewrite(w, r, src)
}

// StreamFile serves a Jellyfin item as a static direct-play file with full HTTP range
// support. The browser can seek to any position via Range requests without transcoding.
// The frontend sets video.currentTime after loadedmetadata to jump to the live position.
func (h *Handler) StreamFile(w http.ResponseWriter, r *http.Request) {
	itemID := r.URL.Query().Get("itemId")
	jfURL, _ := h.DB.GetConfig("jellyfin_url")
	jfKey, _ := h.DB.GetConfig("jellyfin_api_key")

	if jfURL == "" || itemID == "" {
		http.Error(w, "not configured", http.StatusServiceUnavailable)
		return
	}

	target := fmt.Sprintf("%s/Videos/%s/stream?Static=true&api_key=%s&MediaSourceId=%s",
		strings.TrimRight(jfURL, "/"), itemID, jfKey, itemID)

	req, err := http.NewRequestWithContext(r.Context(), "GET", target, nil)
	if err != nil {
		http.Error(w, "proxy error", http.StatusInternalServerError)
		return
	}
	// Forward Range header so the browser can seek to any position
	if rng := r.Header.Get("Range"); rng != "" {
		req.Header.Set("Range", rng)
	}

	resp, err := streamProxyClient.Do(req)
	if err != nil {
		http.Error(w, "upstream error", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	// Forward headers required for range-based seeking
	for _, hdr := range []string{"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified"} {
		if v := resp.Header.Get(hdr); v != "" {
			w.Header().Set(hdr, v)
		}
	}
	w.WriteHeader(resp.StatusCode) // preserve 206 Partial Content for range requests
	io.Copy(w, resp.Body)          //nolint:errcheck
}

// proxyAndRewrite fetches targetURL and pipes it back. If the response is an HLS playlist
// (m3u8), all segment/variant URIs are rewritten to go through /api/stream-segment.
func proxyAndRewrite(w http.ResponseWriter, r *http.Request, targetURL string) {
	req, err := http.NewRequestWithContext(r.Context(), "GET", targetURL, nil)
	if err != nil {
		http.Error(w, "proxy error", http.StatusInternalServerError)
		return
	}
	resp, err := streamProxyClient.Do(req)
	if err != nil {
		http.Error(w, "upstream error", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		http.Error(w, fmt.Sprintf("upstream %d", resp.StatusCode), resp.StatusCode)
		return
	}

	ct := strings.ToLower(resp.Header.Get("Content-Type"))
	isM3U8 := strings.Contains(ct, "mpegurl") || strings.Contains(targetURL, ".m3u8")

	if isM3U8 {
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			http.Error(w, "read error", http.StatusInternalServerError)
			return
		}
		rewritten := rewriteM3U8(string(body), targetURL)
		w.Header().Set("Content-Type", "application/x-mpegURL")
		w.Header().Set("Cache-Control", "no-cache")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(rewritten)) //nolint:errcheck
		return
	}

	// Binary segment — pass through content-type and body.
	if ct != "" {
		w.Header().Set("Content-Type", ct)
	} else {
		w.Header().Set("Content-Type", "video/MP2T")
	}
	if cl := resp.Header.Get("Content-Length"); cl != "" {
		w.Header().Set("Content-Length", cl)
	}
	w.WriteHeader(http.StatusOK)
	io.Copy(w, resp.Body) //nolint:errcheck
}

// uriAttrRe matches URI="..." inside HLS tag lines (e.g. #EXT-X-MAP, #EXT-X-KEY).
var uriAttrRe = regexp.MustCompile(`URI="([^"]+)"`)

// rewriteM3U8 resolves every URI in the playlist relative to baseURL and rewrites it to
// /api/stream-segment?src=<encoded>, so the client only ever talks to cablebox.
// This includes both bare segment lines AND URI= attributes inside tag lines such as
// #EXT-X-MAP (fMP4 init segment) and #EXT-X-KEY (encryption key) — without this, Apple TV
// would try to fetch those URIs directly from Jellyfin's internal Docker hostname and fail.
func rewriteM3U8(content, baseURL string) string {
	base, err := url.Parse(baseURL)
	if err != nil {
		return content
	}
	proxyURI := func(raw string) string {
		ref, err := url.Parse(raw)
		if err != nil {
			return raw
		}
		abs := base.ResolveReference(ref)
		return "/api/stream-segment?src=" + url.QueryEscape(abs.String())
	}
	var sb strings.Builder
	for _, rawLine := range strings.Split(content, "\n") {
		line := strings.TrimRight(rawLine, "\r")
		if line == "" {
			sb.WriteString("\n")
			continue
		}
		if strings.HasPrefix(line, "#") {
			// Rewrite URI="..." attributes within any tag line (e.g. #EXT-X-MAP, #EXT-X-KEY).
			line = uriAttrRe.ReplaceAllStringFunc(line, func(m string) string {
				sub := uriAttrRe.FindStringSubmatch(m)
				if len(sub) < 2 {
					return m
				}
				return `URI="` + proxyURI(sub[1]) + `"`
			})
			sb.WriteString(line + "\n")
			continue
		}
		sb.WriteString(proxyURI(line) + "\n")
	}
	return sb.String()
}

// CreateBlock creates a new schedule block.
func (h *Handler) CreateBlock(w http.ResponseWriter, r *http.Request) {
	var body ScheduleBlock
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, "invalid json", http.StatusBadRequest)
		return
	}

	if body.ChannelID == 0 || body.StartTime == "" || body.DurationSeconds == 0 {
		writeError(w, "channelId, startTime, and durationSeconds are required", http.StatusBadRequest)
		return
	}
	if body.Type == "" {
		body.Type = "episode"
	}
	if body.RecurDays == "" {
		body.RecurDays = "[]"
	}

	isRecurring := 0
	if body.IsRecurring {
		isRecurring = 1
	}

	result, err := h.DB.Exec(`
		INSERT INTO schedule_blocks
		  (channel_id, start_time, duration_seconds, type, jellyfin_item_id,
		   show_id, show_name, episode_name, season_number, episode_number,
		   empty_image_url, is_recurring, recur_days, group_id)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		body.ChannelID, body.StartTime, body.DurationSeconds, body.Type,
		body.JellyfinItemID, body.ShowID, body.ShowName, body.EpisodeName,
		body.SeasonNumber, body.EpisodeNumber, body.EmptyImageURL,
		isRecurring, body.RecurDays, body.GroupID,
	)
	if err != nil {
		writeError(w, "db error: "+err.Error(), http.StatusInternalServerError)
		return
	}

	id, _ := result.LastInsertId()
	body.ID = id
	w.WriteHeader(http.StatusCreated)
	writeJSON(w, body)
}

// UpdateBlock updates an existing schedule block.
func (h *Handler) UpdateBlock(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		writeError(w, "invalid id", http.StatusBadRequest)
		return
	}

	var body ScheduleBlock
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, "invalid json", http.StatusBadRequest)
		return
	}
	if body.RecurDays == "" {
		body.RecurDays = "[]"
	}
	isRecurring := 0
	if body.IsRecurring {
		isRecurring = 1
	}

	_, err = h.DB.Exec(`
		UPDATE schedule_blocks SET
		  channel_id = ?, start_time = ?, duration_seconds = ?, type = ?,
		  jellyfin_item_id = ?, show_id = ?, show_name = ?, episode_name = ?,
		  season_number = ?, episode_number = ?, empty_image_url = ?,
		  is_recurring = ?, recur_days = ?, group_id = ?
		WHERE id = ?`,
		body.ChannelID, body.StartTime, body.DurationSeconds, body.Type,
		body.JellyfinItemID, body.ShowID, body.ShowName, body.EpisodeName,
		body.SeasonNumber, body.EpisodeNumber, body.EmptyImageURL,
		isRecurring, body.RecurDays, body.GroupID, id,
	)
	if err != nil {
		writeError(w, "db error", http.StatusInternalServerError)
		return
	}

	body.ID = id
	writeJSON(w, body)
}

// DeleteBlock removes a schedule block.
func (h *Handler) DeleteBlock(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		writeError(w, "invalid id", http.StatusBadRequest)
		return
	}

	_, err = h.DB.Exec("DELETE FROM schedule_blocks WHERE id = ?", id)
	if err != nil {
		writeError(w, "db error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// GetGroup returns all schedule blocks sharing the given groupId.
func (h *Handler) GetGroup(w http.ResponseWriter, r *http.Request) {
	groupID := chi.URLParam(r, "groupId")
	if groupID == "" {
		writeError(w, "missing groupId", http.StatusBadRequest)
		return
	}

	rows, err := h.DB.Query(`
		SELECT id, channel_id, start_time, duration_seconds, type, jellyfin_item_id,
		       show_id, show_name, episode_name, season_number, episode_number,
		       empty_image_url, is_recurring, recur_days, group_id
		FROM schedule_blocks WHERE group_id = ? ORDER BY start_time`, groupID)
	if err != nil {
		writeError(w, "db error", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	blocks := []ScheduleBlock{}
	for rows.Next() {
		var b ScheduleBlock
		var isRecurring int
		if err := rows.Scan(
			&b.ID, &b.ChannelID, &b.StartTime, &b.DurationSeconds, &b.Type, &b.JellyfinItemID,
			&b.ShowID, &b.ShowName, &b.EpisodeName, &b.SeasonNumber, &b.EpisodeNumber,
			&b.EmptyImageURL, &isRecurring, &b.RecurDays, &b.GroupID,
		); err != nil {
			writeError(w, "scan error", http.StatusInternalServerError)
			return
		}
		b.IsRecurring = isRecurring != 0
		blocks = append(blocks, b)
	}
	writeJSON(w, blocks)
}

// DeleteGroup removes all schedule blocks sharing the given groupId.
func (h *Handler) DeleteGroup(w http.ResponseWriter, r *http.Request) {
	groupID := chi.URLParam(r, "groupId")
	if groupID == "" {
		writeError(w, "missing groupId", http.StatusBadRequest)
		return
	}
	if _, err := h.DB.Exec("DELETE FROM schedule_blocks WHERE group_id = ?", groupID); err != nil {
		writeError(w, "db error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// VerifyPIN checks the admin PIN.
func (h *Handler) VerifyPIN(w http.ResponseWriter, r *http.Request) {
	var body struct {
		PIN string `json:"pin"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, "invalid json", http.StatusBadRequest)
		return
	}

	stored, err := h.DB.GetConfig("admin_pin_hash")
	if err != nil || stored == "" {
		writeError(w, "config error", http.StatusInternalServerError)
		return
	}

	hash := fmt.Sprintf("%x", sha256.Sum256([]byte(body.PIN)))
	if hash != stored {
		writeError(w, "incorrect pin", http.StatusUnauthorized)
		return
	}

	writeJSON(w, map[string]bool{"ok": true})
}

// GetAppConfig returns non-sensitive config values.
func (h *Handler) GetAppConfig(w http.ResponseWriter, r *http.Request) {
	jfURL, _ := h.DB.GetConfig("jellyfin_url")
	jfUser, _ := h.DB.GetConfig("jellyfin_user_id")
	jfPublicURL, _ := h.DB.GetConfig("jellyfin_public_url")
	accentHex, _ := h.DB.GetConfig("accent_hex")
	accentRgb, _ := h.DB.GetConfig("accent_rgb")
	writeJSON(w, map[string]any{
		"jellyfinUrl":        jfURL,
		"jellyfinConfigured": jfURL != "",
		"jellyfinUserId":     jfUser,
		"jellyfinPublicUrl":  jfPublicURL,
		"accentHex":          accentHex,
		"accentRgb":          accentRgb,
	})
}

// UpdateAppConfig saves Jellyfin connection settings and global appearance.
func (h *Handler) UpdateAppConfig(w http.ResponseWriter, r *http.Request) {
	var body struct {
		JellyfinURL       string `json:"jellyfinUrl"`
		JellyfinPublicURL string `json:"jellyfinPublicUrl"`
		JellyfinAPIKey    string `json:"jellyfinApiKey"`
		JellyfinUserID    string `json:"jellyfinUserId"`
		AdminPIN          string `json:"adminPin"`
		AccentHex         string `json:"accentHex"`
		AccentRgb         string `json:"accentRgb"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, "invalid json", http.StatusBadRequest)
		return
	}

	if body.JellyfinURL != "" {
		h.DB.SetConfig("jellyfin_url", strings.TrimRight(body.JellyfinURL, "/"))
	}
	h.DB.SetConfig("jellyfin_public_url", strings.TrimRight(body.JellyfinPublicURL, "/"))
	if body.JellyfinAPIKey != "" {
		h.DB.SetConfig("jellyfin_api_key", body.JellyfinAPIKey)
	}
	if body.JellyfinUserID != "" {
		h.DB.SetConfig("jellyfin_user_id", body.JellyfinUserID)
	}
	if body.AdminPIN != "" {
		hash := fmt.Sprintf("%x", sha256.Sum256([]byte(body.AdminPIN)))
		h.DB.SetConfig("admin_pin_hash", hash)
	}
	if body.AccentHex != "" {
		h.DB.SetConfig("accent_hex", body.AccentHex)
		h.DB.SetConfig("accent_rgb", body.AccentRgb)
	}

	// Clear episode cache when config changes
	h.epCacheMu.Lock()
	h.epCache = make(map[string][]JFEpisode)
	h.epCacheTime = make(map[string]time.Time)
	h.epCacheMu.Unlock()

	writeJSON(w, map[string]bool{"ok": true})
}

func (h *Handler) ClearSchedule(w http.ResponseWriter, r *http.Request) {
	if _, err := h.DB.Exec("DELETE FROM schedule_blocks"); err != nil {
		writeError(w, "db error: "+err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}
