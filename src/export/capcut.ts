import type { ExportInput, Prepared } from './common';
import { zip } from './zip';

// CapCut desktop keeps each project as a folder (draft_content.json +
// draft_meta_info.json) inside its drafts directory. CapCut still opens
// plaintext drafts, so we build one and ship it as a zip to extract there.

const uuid = () => crypto.randomUUID().toUpperCase();
const MATERIAL_LISTS = [
  'ai_translates', 'audio_balances', 'audio_effects', 'audio_fades', 'audio_track_indexes', 'audios', 'beats',
  'canvases', 'chromas', 'color_curves', 'common_mask', 'digital_human_model_dressing', 'digital_humans', 'drafts',
  'effects', 'flowers', 'green_screens', 'handwrites', 'hsl', 'images', 'log_color_wheels', 'loudnesses',
  'manual_beautys', 'manual_deformations', 'material_animations', 'material_colors', 'multi_language_refs',
  'placeholder_infos', 'placeholders', 'plugin_effects', 'primary_color_wheels', 'realtime_denoises', 'shapes',
  'smart_crops', 'smart_relights', 'sound_channel_mappings', 'speeds', 'stickers', 'tail_leaders', 'text_templates',
  'texts', 'time_marks', 'transitions', 'video_effects', 'video_trackings', 'videos', 'vocal_beautifys',
  'vocal_separations',
];

export function toCapcut(input: ExportInput, p: Prepared): { filename: string; data: Uint8Array<ArrayBuffer> } {
  const us = (frames: number) => Math.round((frames * p.rate.num * 1e6) / p.rate.den);
  const path = input.path ?? input.name;
  const materialId = uuid();
  const materials: Record<string, unknown[]> = Object.fromEntries(MATERIAL_LISTS.map((k) => [k, []]));
  const duration = Math.round(input.media.duration * 1e6);

  if (p.hasVideo) {
    materials.videos.push({
      audio_fade: null,
      category_id: '',
      category_name: 'local',
      check_flag: 63487,
      crop: {
        upper_left_x: 0, upper_left_y: 0, upper_right_x: 1, upper_right_y: 0,
        lower_left_x: 0, lower_left_y: 1, lower_right_x: 1, lower_right_y: 1,
      },
      crop_ratio: 'free',
      crop_scale: 1,
      duration,
      height: p.height,
      id: materialId,
      local_material_id: '',
      material_id: materialId,
      material_name: input.name,
      media_path: '',
      path,
      type: 'video',
      width: p.width,
    });
  } else {
    materials.audios.push({
      app_id: 0, category_id: '', category_name: 'local', check_flag: 3, copyright_limit_type: 'none',
      duration, effect_id: '', formula_id: '', id: materialId, local_material_id: materialId,
      music_id: materialId, name: input.name, path, source_platform: 0, type: 'extract_music', wave_points: [],
    });
  }

  const segments = p.clips.map((c) => {
    const speedId = uuid();
    materials.speeds.push({ curve_speed: null, id: speedId, mode: 0, speed: 1, type: 'speed' });
    const start = us(c.recIn);
    const len = us(c.recIn + c.srcOut - c.srcIn) - start;
    const seg: Record<string, unknown> = {
      enable_adjust: true,
      enable_color_correct_adjust: false,
      enable_color_curves: true,
      enable_color_match_adjust: false,
      enable_color_wheels: true,
      enable_lut: true,
      enable_smart_color_adjust: false,
      last_nonzero_volume: 1,
      reverse: false,
      track_attribute: 0,
      track_render_index: 0,
      visible: true,
      id: uuid(),
      material_id: materialId,
      target_timerange: { start, duration: len },
      source_timerange: { start: us(c.srcIn), duration: len },
      common_keyframes: [],
      keyframe_refs: [],
      speed: 1,
      volume: 1,
      extra_material_refs: [speedId],
      render_index: 0,
    };
    if (p.hasVideo) {
      seg.clip = {
        alpha: 1,
        flip: { horizontal: false, vertical: false },
        rotation: 0,
        scale: { x: 1, y: 1 },
        transform: { x: 0, y: 0 },
      };
      seg.uniform_scale = { on: true, value: 1 };
      seg.hdr_settings = { intensity: 1, mode: 1, nits: 1000 };
    }
    return seg;
  });

  const now = Math.floor(Date.now() / 1000);
  const total = us(p.timelineFrames);
  const draftId = uuid();
  const content = {
    canvas_config: { background: null, height: p.height, ratio: 'original', width: p.width },
    color_space: 0,
    config: {
      adjust_max_index: 1, attachment_info: [], combination_max_index: 1, export_range: null,
      extract_audio_last_index: 1, lyrics_recognition_id: '', lyrics_sync: true, lyrics_taskinfo: [],
      maintrack_adsorb: true, material_save_mode: 0, multi_language_current: 'none', multi_language_list: [],
      multi_language_main: 'none', multi_language_mode: 'none', original_sound_last_index: 1,
      record_audio_last_index: 1, sticker_max_index: 1, subtitle_keywords_config: null, subtitle_recognition_id: '',
      subtitle_sync: true, subtitle_taskinfo: [], system_font_list: [], use_float_render: false, video_mute: false,
      zoom_info_params: null,
    },
    cover: null,
    create_time: now,
    duration: total,
    extra_info: null,
    fps: p.rate.fps,
    free_render_index_mode_on: false,
    group_container: null,
    id: draftId,
    is_drop_frame_timecode: false,
    keyframe_graph_list: [],
    keyframes: { adjusts: [], audios: [], effects: [], filters: [], handwrites: [], stickers: [], texts: [], videos: [] },
    last_modified_platform: { app_id: 359289, app_source: 'cc', app_version: '6.7.0', os: 'windows' },
    lyrics_effects: [],
    materials,
    mutable_config: null,
    name: '',
    new_version: '140.0.0',
    path: '',
    platform: { app_id: 359289, app_source: 'cc', app_version: '6.7.0', os: 'windows' },
    relationships: [],
    render_index_track_mode_on: false,
    retouch_cover: null,
    source: 'default',
    static_cover_image_path: '',
    time_marks: null,
    tracks: [
      {
        attribute: 0,
        flag: 0,
        id: uuid(),
        is_default_name: true,
        name: '',
        segments,
        type: p.hasVideo ? 'video' : 'audio',
      },
    ],
    update_time: now,
    version: 360000,
  };

  const folder = `${p.baseName} (Pauseless)`;
  const meta = {
    cloud_draft_cover: false,
    cloud_draft_sync: false,
    draft_cloud_last_action_download: false,
    draft_cover: '',
    draft_fold_path: '',
    draft_id: uuid(),
    draft_is_ai_shorts: false,
    draft_is_invisible: false,
    draft_materials: [0, 1, 2, 3, 6, 7, 8].map((type) => ({ type, value: [] })),
    draft_materials_copied_info: [],
    draft_name: folder,
    draft_new_version: '',
    draft_removable_storage_device: '',
    draft_root_path: '',
    draft_segment_extra_info: [],
    draft_timeline_materials_size_: 0,
    draft_type: '',
    tm_draft_cloud_completed: '',
    tm_draft_cloud_modified: 0,
    tm_draft_create: now * 1e6,
    tm_draft_modified: now * 1e6,
    tm_draft_removed: 0,
    tm_duration: total,
  };

  return {
    filename: `${folder}.zip`,
    data: zip([
      { name: `${folder}/draft_content.json`, data: JSON.stringify(content) },
      { name: `${folder}/draft_meta_info.json`, data: JSON.stringify(meta) },
    ]),
  };
}
