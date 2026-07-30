import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { resolveDataRoot } from "./config.js";

const MIGRATION_1 = `
  CREATE TABLE books (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    author TEXT,
    original_file_path TEXT NOT NULL,
    original_file_hash TEXT NOT NULL UNIQUE,
    encoding TEXT NOT NULL,
    import_status TEXT NOT NULL CHECK (import_status IN ('importing', 'ready', 'failed')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) STRICT;

  CREATE TABLE chapters (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    chapter_index INTEGER NOT NULL CHECK (chapter_index >= 0),
    chapter_number TEXT,
    title TEXT NOT NULL,
    byte_start INTEGER NOT NULL CHECK (byte_start >= 0),
    byte_end INTEGER NOT NULL CHECK (byte_end >= byte_start),
    char_count INTEGER NOT NULL CHECK (char_count >= 0),
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (book_id, chapter_index)
  ) STRICT;

  CREATE INDEX chapters_book_order ON chapters(book_id, chapter_index);
`;

const MIGRATION_2 = `
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
    priority INTEGER NOT NULL DEFAULT 0,
    progress REAL NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
    run_after INTEGER NOT NULL,
    lease_owner TEXT,
    lease_expires_at INTEGER,
    cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
    result_json TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    CHECK (
      (status = 'running' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (status <> 'running' AND lease_owner IS NULL AND lease_expires_at IS NULL)
    )
  ) STRICT;

  CREATE INDEX jobs_ready_queue ON jobs(status, run_after, priority DESC, created_at);
  CREATE INDEX jobs_expired_lease ON jobs(status, lease_expires_at);
`;

const MIGRATION_3 = `
  CREATE TABLE job_checkpoints (
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    stage TEXT NOT NULL CHECK (length(stage) > 0),
    scope_key TEXT NOT NULL CHECK (length(scope_key) > 0),
    input_hash TEXT NOT NULL CHECK (
      length(input_hash) = 64 AND input_hash NOT GLOB '*[^0-9a-f]*'
    ),
    completed_at INTEGER NOT NULL CHECK (completed_at >= 0),
    PRIMARY KEY (job_id, stage, scope_key)
  ) STRICT;
`;

const MIGRATION_4 = `
  CREATE TABLE chapter_events (
    id TEXT PRIMARY KEY,
    chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    event_index INTEGER NOT NULL CHECK (event_index >= 0),
    occurrence INTEGER NOT NULL CHECK (occurrence >= 0),
    event_type TEXT NOT NULL CHECK (
      event_type IN ('character', 'location', 'prop', 'causality', 'revelation', 'suspense')
    ),
    payload_json TEXT NOT NULL CHECK (length(payload_json) > 0),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    UNIQUE (chapter_id, event_index)
  ) STRICT;

  CREATE TABLE chapter_event_sources (
    event_id TEXT NOT NULL REFERENCES chapter_events(id) ON DELETE CASCADE,
    source_index INTEGER NOT NULL CHECK (source_index >= 0),
    source_byte_start INTEGER NOT NULL CHECK (source_byte_start >= 0),
    source_byte_end INTEGER NOT NULL CHECK (source_byte_end > source_byte_start),
    source_hash TEXT NOT NULL CHECK (
      length(source_hash) = 64 AND source_hash NOT GLOB '*[^0-9a-f]*'
    ),
    PRIMARY KEY (event_id, source_index),
    UNIQUE (event_id, source_byte_start, source_byte_end)
  ) STRICT;

  CREATE INDEX chapter_events_chapter_order
    ON chapter_events(chapter_id, event_index);
`;

const MIGRATION_5 = `
  CREATE TABLE series_projects (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    title TEXT NOT NULL CHECK (length(title) > 0),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
  ) STRICT;

  CREATE INDEX series_projects_book_order
    ON series_projects(book_id, created_at, id);

  CREATE TABLE episodes (
    id TEXT PRIMARY KEY,
    series_project_id TEXT NOT NULL REFERENCES series_projects(id) ON DELETE CASCADE,
    episode_index INTEGER NOT NULL CHECK (episode_index >= 1),
    title TEXT NOT NULL CHECK (length(title) > 0),
    story_arc TEXT NOT NULL CHECK (length(story_arc) > 0),
    target_duration_seconds INTEGER NOT NULL CHECK (target_duration_seconds BETWEEN 180 AND 300),
    recap TEXT,
    next_hook TEXT,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
    UNIQUE (series_project_id, episode_index)
  ) STRICT;

  CREATE TABLE episode_sources (
    episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    source_index INTEGER NOT NULL CHECK (source_index >= 0),
    chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    source_event_id TEXT NOT NULL,
    source_byte_start INTEGER NOT NULL CHECK (source_byte_start >= 0),
    source_byte_end INTEGER NOT NULL CHECK (source_byte_end > source_byte_start),
    source_hash TEXT NOT NULL CHECK (
      length(source_hash) = 64 AND source_hash NOT GLOB '*[^0-9a-f]*'
    ),
    PRIMARY KEY (episode_id, source_index)
  ) STRICT;
`;

const MIGRATION_6 = `
  CREATE TABLE script_versions (
    id TEXT PRIMARY KEY,
    episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('faithful', 'packaged')),
    version INTEGER NOT NULL CHECK (version >= 1),
    parent_version_id TEXT REFERENCES script_versions(id),
    content_json TEXT NOT NULL CHECK (length(content_json) > 0),
    content_hash TEXT NOT NULL CHECK (
      length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'
    ),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    UNIQUE (episode_id, kind, version)
  ) STRICT;

  CREATE TABLE script_version_sources (
    script_version_id TEXT NOT NULL REFERENCES script_versions(id) ON DELETE CASCADE,
    segment_index INTEGER NOT NULL CHECK (segment_index >= 0),
    source_index INTEGER NOT NULL CHECK (source_index >= 0),
    episode_source_index INTEGER NOT NULL CHECK (episode_source_index >= 0),
    chapter_id TEXT NOT NULL,
    source_event_id TEXT NOT NULL,
    source_byte_start INTEGER NOT NULL CHECK (source_byte_start >= 0),
    source_byte_end INTEGER NOT NULL CHECK (source_byte_end > source_byte_start),
    source_hash TEXT NOT NULL CHECK (
      length(source_hash) = 64 AND source_hash NOT GLOB '*[^0-9a-f]*'
    ),
    PRIMARY KEY (script_version_id, segment_index, source_index)
  ) STRICT;

  CREATE INDEX script_versions_episode_order
    ON script_versions(episode_id, kind, version);
`;

const MIGRATION_7 = `
  CREATE TABLE script_approval_events (
    id TEXT PRIMARY KEY,
    episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    action TEXT NOT NULL CHECK (action IN ('approve', 'withdraw')),
    script_version_id TEXT NOT NULL REFERENCES script_versions(id),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    UNIQUE (episode_id, revision)
  ) STRICT;

  CREATE INDEX script_approval_events_episode_revision
    ON script_approval_events(episode_id, revision DESC);
`;

const MIGRATION_8 = `
  CREATE TABLE audio_segments (
    timeline_hash TEXT NOT NULL CHECK (
      length(timeline_hash) = 64 AND timeline_hash NOT GLOB '*[^0-9a-f]*'
    ),
    segment_index INTEGER NOT NULL CHECK (segment_index >= 0),
    episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    script_version_id TEXT NOT NULL REFERENCES script_versions(id) ON DELETE CASCADE,
    text TEXT NOT NULL CHECK (length(text) > 0),
    provider_id TEXT NOT NULL CHECK (length(provider_id) > 0),
    voice TEXT NOT NULL CHECK (length(voice) > 0),
    rate INTEGER NOT NULL CHECK (rate BETWEEN -10 AND 10),
    input_hash TEXT NOT NULL CHECK (
      length(input_hash) = 64 AND input_hash NOT GLOB '*[^0-9a-f]*'
    ),
    relative_path TEXT NOT NULL CHECK (length(relative_path) > 0),
    file_hash TEXT NOT NULL CHECK (
      length(file_hash) = 64 AND file_hash NOT GLOB '*[^0-9a-f]*'
    ),
    bytes INTEGER NOT NULL CHECK (bytes > 0),
    duration_ms INTEGER NOT NULL CHECK (duration_ms > 0),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    PRIMARY KEY (timeline_hash, segment_index),
    UNIQUE (timeline_hash, segment_index, episode_id, script_version_id)
  ) STRICT;

  CREATE INDEX audio_segments_episode_script_order
    ON audio_segments(episode_id, script_version_id, timeline_hash, segment_index);

  CREATE TABLE subtitle_cues (
    timeline_hash TEXT NOT NULL CHECK (
      length(timeline_hash) = 64 AND timeline_hash NOT GLOB '*[^0-9a-f]*'
    ),
    cue_index INTEGER NOT NULL CHECK (cue_index >= 0),
    segment_index INTEGER NOT NULL CHECK (segment_index >= 0),
    episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    script_version_id TEXT NOT NULL REFERENCES script_versions(id) ON DELETE CASCADE,
    start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
    end_ms INTEGER NOT NULL CHECK (end_ms > start_ms),
    text TEXT NOT NULL CHECK (length(text) > 0),
    PRIMARY KEY (timeline_hash, cue_index),
    FOREIGN KEY (timeline_hash, segment_index, episode_id, script_version_id)
      REFERENCES audio_segments(timeline_hash, segment_index, episode_id, script_version_id)
      ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX subtitle_cues_episode_script_order
    ON subtitle_cues(episode_id, script_version_id, timeline_hash, cue_index);
`;

const MIGRATION_9 = `
  CREATE TABLE assets (
    id TEXT PRIMARY KEY,
    series_project_id TEXT NOT NULL REFERENCES series_projects(id) ON DELETE CASCADE,
    asset_type TEXT NOT NULL CHECK (asset_type IN ('character', 'scene', 'prop')),
    asset_role TEXT NOT NULL CHECK (asset_role IN ('master', 'state')),
    canonical_name TEXT NOT NULL CHECK (length(canonical_name) > 0),
    normalized_name TEXT NOT NULL CHECK (length(normalized_name) > 0),
    parent_asset_id TEXT,
    state_label TEXT,
    description TEXT,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    UNIQUE (series_project_id, id),
    UNIQUE (series_project_id, asset_type, id),
    CHECK (
      (asset_role = 'master' AND parent_asset_id IS NULL AND state_label IS NULL)
      OR
      (asset_role = 'state' AND parent_asset_id IS NOT NULL AND length(state_label) > 0)
    ),
    CHECK (parent_asset_id IS NULL OR parent_asset_id <> id),
    FOREIGN KEY (series_project_id, asset_type, parent_asset_id)
      REFERENCES assets(series_project_id, asset_type, id)
      DEFERRABLE INITIALLY DEFERRED
  ) STRICT;

  CREATE INDEX assets_series_type_role
    ON assets(series_project_id, asset_type, asset_role, created_at, id);

  CREATE TRIGGER assets_state_parent_is_master
  BEFORE INSERT ON assets
  WHEN NEW.asset_role = 'state'
  BEGIN
    SELECT RAISE(ABORT, 'state asset parent must be master')
    WHERE NOT EXISTS (
      SELECT 1
      FROM assets AS parent
      WHERE parent.id = NEW.parent_asset_id
        AND parent.series_project_id = NEW.series_project_id
        AND parent.asset_type = NEW.asset_type
        AND parent.asset_role = 'master'
    );
  END;

  CREATE TRIGGER assets_state_parent_is_master_on_update
  BEFORE UPDATE ON assets
  WHEN NEW.asset_role = 'state'
  BEGIN
    SELECT RAISE(ABORT, 'state asset parent must be master')
    WHERE NOT EXISTS (
      SELECT 1
      FROM assets AS parent
      WHERE parent.id = NEW.parent_asset_id
        AND parent.series_project_id = NEW.series_project_id
        AND parent.asset_type = NEW.asset_type
        AND parent.asset_role = 'master'
    );
  END;

  CREATE TRIGGER assets_master_with_states_keeps_identity
  BEFORE UPDATE ON assets
  WHEN OLD.asset_role = 'master'
    AND (
      NEW.asset_role <> 'master'
      OR NEW.id <> OLD.id
      OR NEW.series_project_id <> OLD.series_project_id
      OR NEW.asset_type <> OLD.asset_type
    )
    AND EXISTS (
      SELECT 1
      FROM assets AS child
      WHERE child.parent_asset_id = OLD.id
        AND child.series_project_id = OLD.series_project_id
        AND child.asset_type = OLD.asset_type
        AND child.asset_role = 'state'
    )
  BEGIN
    SELECT RAISE(ABORT, 'master asset with state children cannot change hierarchy');
  END;

  CREATE TABLE asset_aliases (
    series_project_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    alias TEXT NOT NULL CHECK (length(alias) > 0),
    normalized_alias TEXT NOT NULL CHECK (length(normalized_alias) > 0),
    is_primary INTEGER NOT NULL CHECK (is_primary IN (0, 1)),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    PRIMARY KEY (series_project_id, normalized_alias),
    FOREIGN KEY (series_project_id, asset_id)
      REFERENCES assets(series_project_id, id) ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX asset_aliases_asset_order
    ON asset_aliases(series_project_id, asset_id, is_primary DESC, normalized_alias);

  CREATE UNIQUE INDEX asset_aliases_one_primary_per_asset
    ON asset_aliases(series_project_id, asset_id)
    WHERE is_primary = 1;
`;

const MIGRATION_10 = `
  CREATE TABLE asset_candidates (
    id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('upload', 'generation')),
    source_identity_hash TEXT NOT NULL CHECK (
      length(source_identity_hash) = 64 AND source_identity_hash NOT GLOB '*[^0-9a-f]*'
    ),
    source_json TEXT NOT NULL CHECK (length(source_json) > 0 AND json_valid(source_json)),
    file_hash TEXT NOT NULL CHECK (
      length(file_hash) = 64 AND file_hash NOT GLOB '*[^0-9a-f]*'
    ),
    mime TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')),
    width INTEGER NOT NULL CHECK (width BETWEEN 16 AND 8192),
    height INTEGER NOT NULL CHECK (height BETWEEN 16 AND 8192),
    bytes INTEGER NOT NULL CHECK (bytes BETWEEN 1 AND 31457280),
    relative_path TEXT NOT NULL CHECK (length(relative_path) > 0),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    UNIQUE (asset_id, source_identity_hash, file_hash)
  ) STRICT;

  CREATE INDEX asset_candidates_asset_order
    ON asset_candidates(asset_id, created_at, id);

  CREATE TABLE asset_candidate_review_events (
    candidate_id TEXT NOT NULL REFERENCES asset_candidates(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    action TEXT NOT NULL CHECK (action IN ('approve', 'reject', 'note')),
    note TEXT,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    PRIMARY KEY (candidate_id, revision),
    CHECK (
      (action = 'note' AND note IS NOT NULL AND length(note) > 0)
      OR (action <> 'note' AND (note IS NULL OR length(note) > 0))
    )
  ) STRICT;
`;

const MIGRATION_11 = `
  CREATE TABLE visual_segments (
    id TEXT PRIMARY KEY,
    episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    segment_index INTEGER NOT NULL CHECK (segment_index >= 0),
    script_version_id TEXT NOT NULL REFERENCES script_versions(id),
    approval_revision INTEGER NOT NULL CHECK (approval_revision >= 1),
    timeline_hash TEXT NOT NULL CHECK (
      length(timeline_hash) = 64 AND timeline_hash NOT GLOB '*[^0-9a-f]*'
    ),
    cue_start_index INTEGER NOT NULL CHECK (cue_start_index >= 0),
    cue_end_index INTEGER NOT NULL CHECK (cue_end_index >= cue_start_index),
    start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
    end_ms INTEGER NOT NULL CHECK (end_ms > start_ms),
    motion_kind TEXT NOT NULL CHECK (
      motion_kind IN ('none', 'pan-left', 'pan-right', 'zoom-in', 'zoom-out')
    ),
    motion_amount_ppm INTEGER NOT NULL CHECK (motion_amount_ppm BETWEEN 0 AND 1000000),
    fade_ms INTEGER NOT NULL CHECK (fade_ms BETWEEN 0 AND 10000),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    UNIQUE (episode_id, timeline_hash, segment_index),
    CHECK (motion_kind <> 'none' OR motion_amount_ppm = 0),
    CHECK (fade_ms * 2 <= end_ms - start_ms)
  ) STRICT;

  CREATE INDEX visual_segments_timeline_order
    ON visual_segments(episode_id, timeline_hash, segment_index);

  CREATE UNIQUE INDEX asset_candidates_id_asset
    ON asset_candidates(id, asset_id);

  CREATE TABLE visual_segment_assets (
    visual_segment_id TEXT NOT NULL REFERENCES visual_segments(id) ON DELETE CASCADE,
    asset_index INTEGER NOT NULL CHECK (asset_index >= 0),
    asset_id TEXT NOT NULL REFERENCES assets(id),
    selected_candidate_id TEXT,
    candidate_review_revision INTEGER,
    PRIMARY KEY (visual_segment_id, asset_index),
    UNIQUE (visual_segment_id, asset_id),
    CHECK (
      (selected_candidate_id IS NULL AND candidate_review_revision IS NULL)
      OR (selected_candidate_id IS NOT NULL AND candidate_review_revision >= 1)
    ),
    FOREIGN KEY (selected_candidate_id, asset_id)
      REFERENCES asset_candidates(id, asset_id)
  ) STRICT;

  CREATE TRIGGER visual_segment_assets_same_series
  BEFORE INSERT ON visual_segment_assets
  BEGIN
    SELECT RAISE(ABORT, 'visual segment asset must belong to episode series')
    WHERE NOT EXISTS (
      SELECT 1
      FROM visual_segments segment
      JOIN episodes episode ON episode.id = segment.episode_id
      JOIN assets asset ON asset.id = NEW.asset_id
      WHERE segment.id = NEW.visual_segment_id
        AND asset.series_project_id = episode.series_project_id
    );
  END;

  CREATE TRIGGER visual_segment_assets_same_series_on_update
  BEFORE UPDATE ON visual_segment_assets
  BEGIN
    SELECT RAISE(ABORT, 'visual segment asset must belong to episode series')
    WHERE NOT EXISTS (
      SELECT 1
      FROM visual_segments segment
      JOIN episodes episode ON episode.id = segment.episode_id
      JOIN assets asset ON asset.id = NEW.asset_id
      WHERE segment.id = NEW.visual_segment_id
        AND asset.series_project_id = episode.series_project_id
    );
  END;
`;

const MIGRATION_12 = `
  CREATE TABLE render_chunks (
    render_hash TEXT PRIMARY KEY CHECK (
      length(render_hash) = 64 AND render_hash NOT GLOB '*[^0-9a-f]*'
    ),
    episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    timeline_hash TEXT NOT NULL CHECK (
      length(timeline_hash) = 64 AND timeline_hash NOT GLOB '*[^0-9a-f]*'
    ),
    chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
    script_version_id TEXT NOT NULL REFERENCES script_versions(id),
    approval_revision INTEGER NOT NULL CHECK (approval_revision >= 1),
    start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
    end_ms INTEGER NOT NULL CHECK (end_ms > start_ms),
    relative_path TEXT NOT NULL CHECK (length(relative_path) > 0),
    file_hash TEXT NOT NULL CHECK (
      length(file_hash) = 64 AND file_hash NOT GLOB '*[^0-9a-f]*'
    ),
    bytes INTEGER NOT NULL CHECK (bytes > 0),
    duration_ms INTEGER NOT NULL CHECK (duration_ms > 0),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    UNIQUE (episode_id, timeline_hash, chunk_index),
    CHECK (end_ms - start_ms BETWEEN 60000 AND 180000)
  ) STRICT;

  CREATE INDEX render_chunks_episode_order
    ON render_chunks(episode_id, timeline_hash, chunk_index);
`;

const MIGRATION_13 = `
  DROP TRIGGER visual_segment_assets_same_series;
  DROP TRIGGER visual_segment_assets_same_series_on_update;

  CREATE TABLE episodes_v13 (
    id TEXT PRIMARY KEY,
    series_project_id TEXT NOT NULL REFERENCES series_projects(id) ON DELETE CASCADE,
    episode_index INTEGER NOT NULL CHECK (episode_index >= 1),
    title TEXT NOT NULL CHECK (length(title) > 0),
    story_arc TEXT NOT NULL CHECK (length(story_arc) > 0),
    target_duration_seconds INTEGER NOT NULL CHECK (target_duration_seconds BETWEEN 60 AND 3600),
    recap TEXT,
    next_hook TEXT,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
    UNIQUE (series_project_id, episode_index)
  ) STRICT;

  INSERT INTO episodes_v13 SELECT * FROM episodes;
  DROP TABLE episodes;
  ALTER TABLE episodes_v13 RENAME TO episodes;

  CREATE TRIGGER visual_segment_assets_same_series
  BEFORE INSERT ON visual_segment_assets
  BEGIN
    SELECT RAISE(ABORT, 'visual segment asset must belong to episode series')
    WHERE NOT EXISTS (
      SELECT 1 FROM visual_segments segment
      JOIN episodes episode ON episode.id = segment.episode_id
      JOIN assets asset ON asset.id = NEW.asset_id
      WHERE segment.id = NEW.visual_segment_id AND asset.series_project_id = episode.series_project_id
    );
  END;

  CREATE TRIGGER visual_segment_assets_same_series_on_update
  BEFORE UPDATE ON visual_segment_assets
  BEGIN
    SELECT RAISE(ABORT, 'visual segment asset must belong to episode series')
    WHERE NOT EXISTS (
      SELECT 1 FROM visual_segments segment
      JOIN episodes episode ON episode.id = segment.episode_id
      JOIN assets asset ON asset.id = NEW.asset_id
      WHERE segment.id = NEW.visual_segment_id AND asset.series_project_id = episode.series_project_id
    );
  END;
`;

const MIGRATION_14 = `
  CREATE TABLE series_pipeline_runs (
    id TEXT PRIMARY KEY,
    series_project_id TEXT NOT NULL REFERENCES series_projects(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN (
      'configured', 'analyzing_chapters', 'building_story_bible', 'planning_episodes',
      'validating_plan', 'freezing_plan', 'generating_scripts', 'checking_coverage',
      'awaiting_review', 'paused', 'failed', 'cancelled', 'completed'
    )),
    resume_status TEXT CHECK (resume_status IS NULL OR resume_status IN (
      'configured', 'analyzing_chapters', 'building_story_bible', 'planning_episodes',
      'validating_plan', 'freezing_plan', 'generating_scripts', 'checking_coverage',
      'awaiting_review', 'failed'
    )),
    episode_count INTEGER NOT NULL CHECK (episode_count BETWEEN 1 AND 1000),
    target_duration_seconds INTEGER NOT NULL CHECK (target_duration_seconds BETWEEN 60 AND 3600),
    source_start_chapter_id TEXT NOT NULL REFERENCES chapters(id),
    source_end_chapter_id TEXT NOT NULL REFERENCES chapters(id),
    config_hash TEXT NOT NULL CHECK (
      length(config_hash) = 64 AND config_hash NOT GLOB '*[^0-9a-f]*'
    ),
    chapter_events_hash TEXT CHECK (
      chapter_events_hash IS NULL OR (
        length(chapter_events_hash) = 64 AND chapter_events_hash NOT GLOB '*[^0-9a-f]*'
      )
    ),
    story_bible_id TEXT,
    plan_hash TEXT CHECK (
      plan_hash IS NULL OR (length(plan_hash) = 64 AND plan_hash NOT GLOB '*[^0-9a-f]*')
    ),
    failure_code TEXT CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 128),
    failure_message TEXT CHECK (failure_message IS NULL OR length(failure_message) BETWEEN 1 AND 2000),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
    CHECK ((status = 'paused') = (resume_status IS NOT NULL))
  ) STRICT;

  CREATE UNIQUE INDEX series_pipeline_runs_one_current
    ON series_pipeline_runs(series_project_id)
    WHERE status NOT IN ('cancelled', 'completed');

  CREATE INDEX series_pipeline_runs_status
    ON series_pipeline_runs(status, updated_at, id);

  CREATE TABLE series_pipeline_jobs (
    run_id TEXT NOT NULL REFERENCES series_pipeline_runs(id) ON DELETE CASCADE,
    stage TEXT NOT NULL CHECK (stage IN ('chapter_analysis', 'story_bible', 'episode_plan', 'script_generation')),
    subject_type TEXT NOT NULL CHECK (subject_type IN ('chapter', 'bible_chunk', 'plan', 'episode')),
    subject_id TEXT NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 200),
    job_id TEXT NOT NULL REFERENCES jobs(id),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    PRIMARY KEY (run_id, stage, subject_type, subject_id)
  ) STRICT;

  CREATE INDEX series_pipeline_jobs_job
    ON series_pipeline_jobs(job_id);
`;

const MIGRATION_15 = `
  CREATE TABLE book_story_bibles (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    scope TEXT NOT NULL CHECK (scope IN ('interval', 'final')),
    source_start_chapter_id TEXT NOT NULL REFERENCES chapters(id),
    source_end_chapter_id TEXT NOT NULL REFERENCES chapters(id),
    source_event_ids_json TEXT NOT NULL CHECK (
      length(source_event_ids_json) BETWEEN 3 AND 1048576
    ),
    source_events_hash TEXT NOT NULL CHECK (
      length(source_events_hash) = 64 AND source_events_hash NOT GLOB '*[^0-9a-f]*'
    ),
    parent_bible_ids_json TEXT NOT NULL CHECK (
      length(parent_bible_ids_json) BETWEEN 2 AND 1048576
    ),
    input_hash TEXT NOT NULL CHECK (
      length(input_hash) = 64 AND input_hash NOT GLOB '*[^0-9a-f]*'
    ),
    contract_version TEXT NOT NULL CHECK (length(contract_version) BETWEEN 1 AND 100),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 200),
    model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
    job_id TEXT REFERENCES jobs(id),
    content_json TEXT NOT NULL CHECK (length(content_json) BETWEEN 2 AND 8388608),
    content_hash TEXT NOT NULL CHECK (
      length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'
    ),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    invalidated_at INTEGER CHECK (invalidated_at IS NULL OR invalidated_at >= created_at),
    UNIQUE (
      book_id, scope, source_start_chapter_id, source_end_chapter_id,
      source_events_hash, input_hash, contract_version, revision
    )
  ) STRICT;

  CREATE INDEX book_story_bibles_reuse
    ON book_story_bibles (
      book_id, scope, source_start_chapter_id, source_end_chapter_id,
      source_events_hash, input_hash, contract_version, invalidated_at, revision DESC
    );

  CREATE TRIGGER book_story_bibles_range_guard
  BEFORE INSERT ON book_story_bibles
  BEGIN
    SELECT RAISE(ABORT, 'book story bible range must belong to book and be ordered')
    WHERE NOT EXISTS (
      SELECT 1 FROM chapters start
      JOIN chapters finish ON finish.book_id = start.book_id
      WHERE start.id = NEW.source_start_chapter_id
        AND finish.id = NEW.source_end_chapter_id
        AND start.book_id = NEW.book_id
        AND start.chapter_index <= finish.chapter_index
    );
  END;

  CREATE TRIGGER book_story_bibles_immutable
  BEFORE UPDATE ON book_story_bibles
  WHEN NEW.id IS NOT OLD.id
    OR NEW.book_id IS NOT OLD.book_id
    OR NEW.scope IS NOT OLD.scope
    OR NEW.source_start_chapter_id IS NOT OLD.source_start_chapter_id
    OR NEW.source_end_chapter_id IS NOT OLD.source_end_chapter_id
    OR NEW.source_event_ids_json IS NOT OLD.source_event_ids_json
    OR NEW.source_events_hash IS NOT OLD.source_events_hash
    OR NEW.parent_bible_ids_json IS NOT OLD.parent_bible_ids_json
    OR NEW.input_hash IS NOT OLD.input_hash
    OR NEW.contract_version IS NOT OLD.contract_version
    OR NEW.revision IS NOT OLD.revision
    OR NEW.provider_id IS NOT OLD.provider_id
    OR NEW.model IS NOT OLD.model
    OR NEW.job_id IS NOT OLD.job_id
    OR NEW.content_json IS NOT OLD.content_json
    OR NEW.content_hash IS NOT OLD.content_hash
    OR NEW.created_at IS NOT OLD.created_at
    OR OLD.invalidated_at IS NOT NULL
    OR NEW.invalidated_at IS NULL
  BEGIN
    SELECT RAISE(ABORT, 'book story bible versions are immutable');
  END;
`;

const MIGRATION_16 = `
  ALTER TABLE series_pipeline_runs
    ADD COLUMN chapter_batch_size INTEGER NOT NULL DEFAULT 1
      CHECK (chapter_batch_size BETWEEN 1 AND 20);
  ALTER TABLE series_pipeline_runs
    ADD COLUMN chapter_concurrency INTEGER NOT NULL DEFAULT 1
      CHECK (chapter_concurrency BETWEEN 1 AND 8);
`;

const MIGRATION_17 = `
  ALTER TABLE job_checkpoints
    ADD COLUMN output_json TEXT
      CHECK (
        output_json IS NULL OR (
          json_valid(output_json)
          AND length(CAST(output_json AS BLOB)) <= 1048576
        )
      );
`;

const MIGRATION_18 = `
  ALTER TABLE script_versions ADD COLUMN script_contract_version INTEGER NOT NULL DEFAULT 5
    CHECK (script_contract_version IN (5, 6));
  ALTER TABLE series_pipeline_runs ADD COLUMN planning_contract_version INTEGER NOT NULL DEFAULT 1
    CHECK (planning_contract_version IN (1, 2));
  ALTER TABLE series_pipeline_runs ADD COLUMN episode_ranges_json TEXT
    CHECK (episode_ranges_json IS NULL OR json_valid(episode_ranges_json));
  ALTER TABLE series_pipeline_runs ADD COLUMN script_contract_version INTEGER NOT NULL DEFAULT 5
    CHECK (script_contract_version IN (5, 6));
  ALTER TABLE series_pipeline_runs ADD COLUMN product_prompt_version TEXT
    CHECK (product_prompt_version IS NULL OR length(product_prompt_version) BETWEEN 1 AND 100);
  ALTER TABLE series_pipeline_runs ADD COLUMN book_prompt_profile_revision INTEGER
    CHECK (book_prompt_profile_revision IS NULL OR book_prompt_profile_revision >= 1);
  ALTER TABLE series_pipeline_runs ADD COLUMN book_prompt_profile_hash TEXT
    CHECK (book_prompt_profile_hash IS NULL OR (
      length(book_prompt_profile_hash) = 64 AND book_prompt_profile_hash NOT GLOB '*[^0-9a-f]*'
    ));

  CREATE TABLE book_prompt_profiles (
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    shared_instructions TEXT NOT NULL,
    chapter_analysis_instructions TEXT NOT NULL,
    story_bible_instructions TEXT NOT NULL,
    episode_planning_instructions TEXT NOT NULL,
    narration_instructions TEXT NOT NULL,
    asset_instructions TEXT NOT NULL,
    profile_hash TEXT NOT NULL CHECK (
      length(profile_hash) = 64 AND profile_hash NOT GLOB '*[^0-9a-f]*'
    ),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    PRIMARY KEY (book_id, revision)
  ) STRICT;

  CREATE TRIGGER book_prompt_profiles_immutable BEFORE UPDATE ON book_prompt_profiles
  BEGIN SELECT RAISE(ABORT, 'book prompt profile revisions are immutable'); END;
`;

const MIGRATION_19 = `
  ALTER TABLE series_pipeline_runs ADD COLUMN chapter_concurrency_v19 INTEGER;
  UPDATE series_pipeline_runs SET chapter_concurrency_v19 = chapter_concurrency;
  ALTER TABLE series_pipeline_runs DROP COLUMN chapter_concurrency;
  ALTER TABLE series_pipeline_runs ADD COLUMN chapter_concurrency INTEGER NOT NULL DEFAULT 1
    CHECK (chapter_concurrency BETWEEN 1 AND 50);
  UPDATE series_pipeline_runs SET chapter_concurrency = chapter_concurrency_v19;
  ALTER TABLE series_pipeline_runs DROP COLUMN chapter_concurrency_v19;
`;

const MIGRATIONS = [
  MIGRATION_1, MIGRATION_2, MIGRATION_3, MIGRATION_4, MIGRATION_5, MIGRATION_6, MIGRATION_7, MIGRATION_8,
  MIGRATION_9,
  MIGRATION_10,
  MIGRATION_11,
  MIGRATION_12,
  MIGRATION_13,
  MIGRATION_14,
  MIGRATION_15,
  MIGRATION_16,
  MIGRATION_17,
  MIGRATION_18,
  MIGRATION_19,
];

export interface YingshuDatabase {
  database: DatabaseSync;
  path: string;
  close(): void;
}

export function openDatabase(dataRoot?: string): YingshuDatabase {
  const root = resolveDataRoot(dataRoot);
  mkdirSync(root, { recursive: true });

  const path = join(root, "yingshu.sqlite3");
  const database = new DatabaseSync(path);

  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) STRICT;
    `);

    const applied = database
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: number }>;
    if (applied.length > MIGRATIONS.length ||
        applied.some((migration, index) => migration.version !== index + 1)) {
      throw new Error("数据库迁移版本不兼容");
    }

    for (let index = applied.length; index < MIGRATIONS.length; index += 1) {
      const rebuildsEpisodes = index === 12;
      if (rebuildsEpisodes) database.exec("PRAGMA foreign_keys = OFF");
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec(MIGRATIONS[index]!);
        if (rebuildsEpisodes && database.prepare("PRAGMA foreign_key_check").all().length) {
          throw new Error("数据库迁移后外键校验失败");
        }
        database.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(index + 1);
        database.exec("COMMIT");
      } catch (error) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // 保留原始迁移错误；外层仍会关闭连接。
        }
        throw error;
      } finally {
        if (rebuildsEpisodes) database.exec("PRAGMA foreign_keys = ON");
      }
    }

    return {
      database,
      path,
      close: () => database.close(),
    };
  } catch (error) {
    try {
      database.close();
    } catch {
      // 抛出导致初始化失败的原始错误。
    }
    throw error;
  }
}
