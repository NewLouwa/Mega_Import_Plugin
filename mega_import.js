"use strict";
(function() {
  const api = window.PluginApi;
  const React = api.React;
  const { Button, Modal, Form, Alert, Collapse, InputGroup } = api.libraries.Bootstrap;
  const { faCloudDownloadAlt, faSpinner, faSignInAlt, faFolder, faFile, faHome, faSignOutAlt, faCog, faCheckSquare, faSquare, faFilter, faSearch, faTimes, faHistory, faCheck } = api.libraries.FontAwesomeSolid;
  const { Icon } = api.components;
  const { gql, useApolloClient } = api.libraries.Apollo;

  // Navigation compat shim.
  // api.utils.navigate was added in a later Stash build; older builds don't
  // have it.  Fall back to window.location.assign (causes a full page reload
  // but still navigates correctly).
  const navigateTo = (path) => {
    if (typeof api.utils?.navigate === "function") {
      api.utils.navigate(path);
    } else {
      window.location.assign(path);
    }
  };

  const LOG_PREFIX = "[mega-import]";
  const OPEN_LOGIN_EVENT = "mega-import:open-login";
  const PLUGIN_ID = "mega_import";
  const TASK_NAME = "MEGA Operation";
  const SESSION_STORAGE_KEY = "mega-import:session";
  const SETTINGS_STORAGE_KEY = "mega-import:settings";
  const HISTORY_STORAGE_KEY = "mega-import:history";
  const PATH_CACHE_KEY = "mega-import:path-cache";
  const PATH_CACHE_TTL = 60 * 60 * 1000; // 1h since last use
  const HISTORY_MAX_ENTRIES = 500;
  const DEFAULT_SETTINGS = {
    dest: "",
    filter: "all",
    customExts: "",
    concurrency: 3,
    pageSize: 10,
    defaultSort: "size_asc",
    autoAddToLibrary: true,
    generateAfterScan: false,
    autoTagAfterImport: true,
    identifyAfterImport: true,
    skipAlreadyImported: true,
    overwriteExisting: false,
  };
  const MAX_CONCURRENCY = 5;
  const DEFAULT_HISTORY = { entries: [] }; // [{path, dest, status, ts}]

  // File-type filter groups. Backend returns no MIME — we filter on extension.
  const FILTER_GROUPS = {
    all: null, // no filter
    videos: ["mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "mpg", "mpeg", "ts"],
    images: ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "tiff", "heic"],
  };

  const fileExt = (name) => {
    const i = name.lastIndexOf(".");
    return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
  };

  // Best-effort folder-name parser — extracts year/studio/performers from
  // common patterns. Returns { studio?, year?, performers? [], title? }.
  const parseFolderName = (name) => {
    if (!name) return {};
    const out = {};
    const base = String(name).replace(/^\/+|\/+$/g, "").split("/").pop() || "";
    const y = base.match(/[\(\[](19\d{2}|20\d{2})[\)\]]/);
    if (y) out.year = parseInt(y[1], 10);
    const performers = [];
    const re = /[\[\{]([^\]\}]{2,40})[\]\}]/g;
    let m;
    while ((m = re.exec(base)) !== null) {
      const c = m[1].trim();
      if (/^(\d{3,4}p?|19\d{2}|20\d{2}|UHD|HD|SD|4K)$/i.test(c)) continue;
      performers.push(c);
    }
    if (performers.length) out.performers = performers;
    const sm = base.match(/\(([^)]{2,40})\)/);
    if (sm) {
      const c = sm[1].trim();
      if (!/^(\d{4}|\d{3,4}p|UHD|HD|SD|4K|x264|x265|h264|h265|HEVC|WEB[-_ ]?DL|BluRay|BDRip|DVDRip|XXX|MP4)$/i.test(c)) {
        out.studio = c;
      }
    }
    // Title cleanup: strip brackets/parens/quality tags, collapse separators.
    let t = base.replace(/[\[\{][^\]\}]*[\]\}]/g, " ")
                .replace(/\([^)]*\)/g, " ")
                .replace(/\b(2160p|1080p|720p|480p|360p|4K|UHD|HD|SD|XXX|WEB[-_ ]?DL|WEBRip|BluRay|x264|x265|HEVC)\b/gi, " ")
                .replace(/[._\-]+/g, " ")
                .replace(/\s+/g, " ").trim();
    if (t) out.title = t;
    return out;
  };

  const humanSize = (bytes) => {
    if (bytes == null || bytes === 0) return "";
    const u = ["B", "KB", "MB", "GB", "TB"];
    let i = 0, n = bytes;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
  };

  const matchesFilter = (file, filter, customExts) => {
    if (file.type === "folder") return true;
    if (filter === "all") return true;
    if (filter === "custom") {
      const exts = (customExts || "").split(",").map(s => s.trim().toLowerCase().replace(/^\./, "")).filter(Boolean);
      return exts.length === 0 || exts.includes(fileExt(file.name));
    }
    const group = FILTER_GROUPS[filter];
    return !group || group.includes(fileExt(file.name));
  };

  // Import history — persisted to localStorage so the "already imported"
  // indicator and the History panel survive reloads. Module-level (not a hook)
  // because MegaApiClient.downloadFiles needs to write entries, and components
  // need to subscribe.
  // PathCache — per-directory metadata cache in localStorage.
  // Each entry { items: [...], ts: <writeTime>, lastUsed: <readOrWriteTime> }.
  // Entries auto-prune when their lastUsed is older than PATH_CACHE_TTL.
  // Survives page reloads; cleared on logout.
  const PathCache = {
    _read() {
      try {
        const raw = localStorage.getItem(PATH_CACHE_KEY);
        return raw ? JSON.parse(raw) : {};
      } catch (e) { logError("path-cache read", e); return {}; }
    },
    _write(obj) {
      try { localStorage.setItem(PATH_CACHE_KEY, JSON.stringify(obj)); }
      catch (e) { logError("path-cache write", e, { size: Object.keys(obj).length }); }
    },
    prune() {
      const all = this._read();
      const now = Date.now();
      let removed = 0;
      for (const [k, v] of Object.entries(all)) {
        if (!v || (now - (v.lastUsed || v.ts || 0)) > PATH_CACHE_TTL) {
          delete all[k];
          removed++;
        }
      }
      if (removed > 0) this._write(all);
      return removed;
    },
    get(path) {
      const all = this._read();
      const entry = all[path];
      if (!entry) return null;
      const age = Date.now() - (entry.lastUsed || entry.ts || 0);
      if (age > PATH_CACHE_TTL) {
        delete all[path];
        this._write(all);
        return null;
      }
      // Touch lastUsed so frequently-visited dirs stay fresh.
      entry.lastUsed = Date.now();
      all[path] = entry;
      this._write(all);
      return entry;
    },
    set(path, items) {
      const all = this._read();
      const now = Date.now();
      all[path] = { items, ts: now, lastUsed: now };
      this._write(all);
    },
    clear() {
      try { localStorage.removeItem(PATH_CACHE_KEY); } catch (e) { logError("path-cache clear", e); }
    },
  };

  const HistoryStore = {
    _listeners: new Set(),
    read() {
      try {
        const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
        return raw ? JSON.parse(raw) : DEFAULT_HISTORY;
      } catch (e) {
        logError("history read", e);
        return DEFAULT_HISTORY;
      }
    },
    write(history) {
      try { localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history)); }
      catch (e) { logError("history write", e); }
      this._listeners.forEach(cb => { try { cb(history); } catch (e) { logError("history listener", e); } });
    },
    record(entries) {
      const current = this.read();
      const merged = entries.concat(current.entries).slice(0, HISTORY_MAX_ENTRIES);
      this.write({ entries: merged });
    },
    clear() { this.write(DEFAULT_HISTORY); },
    onChange(cb) {
      this._listeners.add(cb);
      return () => this._listeners.delete(cb);
    },
  };

  const useHistory = () => {
    const [history, setHistory] = React.useState(() => HistoryStore.read());
    React.useEffect(() => HistoryStore.onChange(setHistory), []);
    return history;
  };

  // Set of paths previously imported successfully — for the "already imported"
  // checkmark in the file list.
  const useImportedSet = () => {
    const history = useHistory();
    return React.useMemo(() => {
      const s = new Set();
      for (const e of history.entries) {
        if (e.status === "ok") s.add(e.path);
      }
      return s;
    }, [history]);
  };

  const useLocalStorage = (key, fallback) => {
    const [value, setValue] = React.useState(() => {
      try {
        const raw = localStorage.getItem(key);
        return raw ? Object.assign({}, fallback, JSON.parse(raw)) : fallback;
      } catch (e) {
        logError("localStorage read", e, { key });
        return fallback;
      }
    });
    const setAndPersist = React.useCallback((next) => {
      setValue(prev => {
        const merged = typeof next === "function" ? next(prev) : Object.assign({}, prev, next);
        try { localStorage.setItem(key, JSON.stringify(merged)); }
        catch (e) { logError("localStorage write", e, { key }); }
        return merged;
      });
    }, [key]);
    return [value, setAndPersist];
  };

  // Bridge constants — uses runPluginOperation (Stash v0.25+) which is
  // synchronous: no job queue, no polling. The Python "output" value comes
  // back directly in data.runPluginOperation; Python "error" becomes a
  // GraphQL error. Replaces the old runPluginTask+findJob+job.error hack
  // which was broken in Stash v0.31.
  const RUN_OPERATION = gql`
    mutation MegaImport_RunOp($id: ID!, $args: Map!) {
      runPluginOperation(plugin_id: $id, args: $args)
    }
  `;
  const METADATA_SCAN = gql`
    mutation MegaImport_Scan($input: ScanMetadataInput!) {
      metadataScan(input: $input)
    }
  `;
  const METADATA_GENERATE = gql`
    mutation MegaImport_Generate($input: GenerateMetadataInput!) {
      metadataGenerate(input: $input)
    }
  `;
  const METADATA_AUTOTAG = gql`
    mutation MegaImport_AutoTag($input: AutoTagMetadataInput!) {
      metadataAutoTag(input: $input)
    }
  `;
  const METADATA_IDENTIFY = gql`
    mutation MegaImport_Identify($input: IdentifyMetadataInput!) {
      metadataIdentify(input: $input)
    }
  `;
  // Tag/Performer/Studio resolution + bulk apply.
  const FIND_TAGS = gql`query MegaImport_FindTags($q: String!) { findTags(filter: { q: $q, per_page: 50 }) { tags { id name } } }`;
  const TAG_CREATE = gql`mutation MegaImport_TagCreate($input: TagCreateInput!) { tagCreate(input: $input) { id name } }`;
  const FIND_PERFORMERS = gql`query MegaImport_FindPerformers($q: String!) { findPerformers(filter: { q: $q, per_page: 50 }) { performers { id name } } }`;
  const PERFORMER_CREATE = gql`mutation MegaImport_PerformerCreate($input: PerformerCreateInput!) { performerCreate(input: $input) { id name } }`;
  const FIND_STUDIOS = gql`query MegaImport_FindStudios($q: String!) { findStudios(filter: { q: $q, per_page: 50 }) { studios { id name } } }`;
  const STUDIO_CREATE = gql`mutation MegaImport_StudioCreate($input: StudioCreateInput!) { studioCreate(input: $input) { id name } }`;
  const FIND_IMAGES_BY_PATH = gql`query MegaImport_FindImagesByPath($path: String!) { findImages(image_filter: { path: { value: $path, modifier: INCLUDES } }, filter: { per_page: -1 }) { images { id files { path } } } }`;
  const FIND_SCENES_BY_PATH = gql`query MegaImport_FindScenesByPath($path: String!) { findScenes(scene_filter: { path: { value: $path, modifier: INCLUDES } }, filter: { per_page: -1 }) { scenes { id files { path } } } }`;
  const BULK_IMAGE_UPDATE = gql`mutation MegaImport_BulkImageUpdate($input: BulkImageUpdateInput!) { bulkImageUpdate(input: $input) { id } }`;
  const BULK_SCENE_UPDATE = gql`mutation MegaImport_BulkSceneUpdate($input: BulkSceneUpdateInput!) { bulkSceneUpdate(input: $input) { id } }`;
  const GALLERY_CREATE = gql`mutation MegaImport_GalleryCreate($input: GalleryCreateInput!) { galleryCreate(input: $input) { id title } }`;
  const ADD_GALLERY_IMAGES = gql`mutation MegaImport_AddGalleryImages($gallery_id: ID!, $image_ids: [ID!]!) { addGalleryImages(input: { gallery_id: $gallery_id, image_ids: $image_ids }) }`;
  const QUERY_CONFIG = gql`
    query MegaImport_Config { configuration { general { stashes { path } } } }
  `;
  const CONFIGURE_GENERAL = gql`
    mutation MegaImport_Configure($input: ConfigGeneralInput!) {
      configureGeneral(input: $input) { stashes { path } }
    }
  `;

  const megaLogoSVG = '<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" width="20" height="20" viewBox="0 0 361.4 361.4"><path fill="#d9272e" d="M180.7 0C80.9 0 0 80.9 0 180.7c0 99.8 80.9 180.7 180.7 180.7 99.8 0 180.7-80.9 180.7-180.7C361.4 80.9 280.5 0 180.7 0Zm93.8 244.6c0 3.1-2.5 5.6-5.6 5.6h-23.6c-3.1 0-5.6-2.5-5.6-5.6v-72.7c0-.6-.7-.9-1.2-.5l-50 50c-4.3 4.3-11.4 4.3-15.7 0l-50-50c-.4-.4-1.2-.1-1.2.5v72.7c0 3.1-2.5 5.6-5.6 5.6H92.4c-3.1 0-5.6-2.5-5.6-5.6V116.8c0-3.1 2.5-5.6 5.6-5.6h16.2c2.9 0 5.8 1.2 7.9 3.3l62.2 62.2c1.1 1.1 2.8 1.1 3.9 0l62.2-62.2c2.1-2.1 4.9-3.3 7.9-3.3h16.2c3.1 0 5.6 2.5 5.6 5.6v127.8z"/></svg>';
  const megaLogoSVGLarge = '<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" width="30" height="30" viewBox="0 0 361.4 361.4"><path fill="#d9272e" d="M180.7 0C80.9 0 0 80.9 0 180.7c0 99.8 80.9 180.7 180.7 180.7 99.8 0 180.7-80.9 180.7-180.7C361.4 80.9 280.5 0 180.7 0Zm93.8 244.6c0 3.1-2.5 5.6-5.6 5.6h-23.6c-3.1 0-5.6-2.5-5.6-5.6v-72.7c0-.6-.7-.9-1.2-.5l-50 50c-4.3 4.3-11.4 4.3-15.7 0l-50-50c-.4-.4-1.2-.1-1.2.5v72.7c0 3.1-2.5 5.6-5.6 5.6H92.4c-3.1 0-5.6-2.5-5.6-5.6V116.8c0-3.1 2.5-5.6 5.6-5.6h16.2c2.9 0 5.8 1.2 7.9 3.3l62.2 62.2c1.1 1.1 2.8 1.1 3.9 0l62.2-62.2c2.1-2.1 4.9-3.3 7.9-3.3h16.2c3.1 0 5.6 2.5 5.6 5.6v127.8z"/></svg>';

  const logError = (where, error, context) => {
    console.error(`${LOG_PREFIX} ${where} failed:`, {
      message: error && error.message,
      error,
      context: context || {},
    });
  };

  // MegaApiClient
  // -------------
  // Single integration seam between the React UI and the Stash plugin task that
  // wraps MEGAcmd. All MEGA traffic goes server-side; the browser only talks to
  // Stash's GraphQL endpoint.
  //
  // Contract:
  //   login(email, password, rememberMe) -> Promise<{ email }>
  //   listFiles(path) -> Promise<Array<{ id, name, type: 'file'|'folder', size?, path }>>
  //   downloadFiles(paths) -> Promise<{ imported, items: [{ name, status, error? }] }>
  //   logout() -> Promise<void>
  //   isLoggedIn() / getSession() -> sync accessors
  //   onSessionChange(cb) -> subscribe; returns unsubscribe fn
  //   _setApolloClient(client) -> wired by ApolloCapture component on mount
  const MegaApiClient = {
    _session: null,
    _listeners: new Set(),
    _client: null,

    isLoggedIn() { return this._session !== null; },
    getSession() { return this._session; },

    onSessionChange(cb) {
      this._listeners.add(cb);
      return () => this._listeners.delete(cb);
    },

    _emitSessionChange() {
      // Persist to sessionStorage so a page reload on /mega-browser survives.
      try {
        if (this._session) sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(this._session));
        else sessionStorage.removeItem(SESSION_STORAGE_KEY);
      } catch (e) { logError("session persist", e); }
      this._listeners.forEach(cb => {
        try { cb(this._session); } catch (e) { logError("session listener", e); }
      });
    },

    _hydrateSession() {
      try {
        const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
        if (raw) this._session = JSON.parse(raw);
      } catch (e) { logError("session hydrate", e); }
    },

    _setApolloClient(client) { this._client = client; },

    // Per-action timeout overrides (ms).
    // login must solve a SHA-256 Hashcash proof-of-work that MEGA's API
    // requires; on a single-CPU container this can take 2-5 minutes.
    // All other actions are fast network/IO calls capped at 2 minutes.
    _timeoutMs(action, sizeBytes) {
      if (action === "login") return 10 * 60 * 1000;  // 10 min — PoW may take 3-5 min
      // list/find walk the entire MEGA tree on first call; multi-TB accounts
      // can take 1-3 min.  After the first call the on-disk cache makes them
      // near-instant.
      if (action === "list" || action === "find" || action === "preview") return 5 * 60 * 1000;
      if (action === "download") {
        // Pessimistic: assume 200 KB/s throughput. Add 60s overhead for
        // hashcash retries / connection setup. Floor at 2 min, cap at 1 hour
        // per single download call (folder downloads should be expanded
        // client-side via preview before they hit this).
        const MIN_MS = 2 * 60 * 1000;
        const MAX_MS = 60 * 60 * 1000;
        if (typeof sizeBytes === "number" && sizeBytes > 0) {
          const est = 60_000 + Math.ceil(sizeBytes / 200_000) * 1000;
          return Math.min(MAX_MS, Math.max(MIN_MS, est));
        }
        // Unknown size (e.g. raw folder path): be generous — 30 min default.
        return 30 * 60 * 1000;
      }
      return 120_000;                                   // 2 min for everything else
    },

    // Run a backend action via runPluginOperation (Stash v0.25+).
    // Synchronous: one GraphQL round-trip, no polling.
    // Python "output" → resolved value; Python "error" → GraphQL error → rejected promise.
    async _runTask(action, args, sizeHint) {
      // ApolloCapture sets _client in a useEffect; on a direct reload to
      // /mega-browser the page can mount before that fires. Short grace period.
      const waitDeadline = Date.now() + 3000;
      while (!this._client && Date.now() < waitDeadline) {
        await new Promise(r => setTimeout(r, 50));
      }
      if (!this._client) {
        throw new Error("Apollo client not initialized — plugin not fully loaded");
      }
      const argsMap = Object.assign({ action }, args || {});
      console.log(`[mega-import] _runTask → action=${action}`, argsMap);
      const t0 = Date.now();

      const TIMEOUT_MS = this._timeoutMs(action, sizeHint);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Backend timed out after ${Math.round(TIMEOUT_MS / 1000)}s (action=${action}${sizeHint ? `, size=${Math.round(sizeHint/1e6)}MB` : ""})`)), TIMEOUT_MS)
      );

      try {
        const resp = await Promise.race([
          this._client.mutate({
            mutation: RUN_OPERATION,
            variables: { id: PLUGIN_ID, args: argsMap },
          }),
          timeoutPromise,
        ]);
        const result = resp && resp.data && resp.data.runPluginOperation;
        console.log(`[mega-import] _runTask ← action=${action} in ${Date.now() - t0}ms`, result);
        return result;
      } catch (e) {
        // GraphQL errors from Python's {"error": "..."} land here.
        const msg = (e.graphQLErrors && e.graphQLErrors[0] && e.graphQLErrors[0].message)
          || e.message || String(e);
        console.error(`[mega-import] _runTask ✗ action=${action} in ${Date.now() - t0}ms — ${msg}`, e);
        logError("runPluginOperation", e, { action });
        throw new Error(msg);
      }
    },

    async login(email, password) {
      console.log("[mega-import] login: calling backend...");
      const result = await this._runTask("login", { email, password });
      console.log("[mega-import] login: backend responded", result);
      if (!result || !result.email) {
        throw new Error("Backend returned no email — login may have failed silently");
      }
      this._session = { email: result.email, sessionToken: result.session_token || null };
      this._emitSessionChange();
      return this._session;
    },

    async loginWithToken(sessionToken) {
      console.log("[mega-import] loginWithToken: calling backend...");
      const result = await this._runTask("login", { session_token: sessionToken });
      console.log("[mega-import] loginWithToken: backend responded", result);
      if (!result || !result.email) {
        throw new Error("Backend returned no email — token may be invalid or expired");
      }
      this._session = { email: result.email, sessionToken: result.session_token || sessionToken };
      this._emitSessionChange();
      return this._session;
    },

    async previewExpansion(paths) {
      // Server-side recursive expansion. Returns:
      //   { total_files, total_size, by_ext: {ext:{count,bytes}}, files:[{path,size,ext}] }
      return this._runTask("preview", { paths });
    },

    async tempProgress() {
      // [{name, size, mtime, age_s}] of /tmp/megapy_* — used to plot REAL
      // byte progress for in-flight downloads.  Cheap (a stat() per file).
      return this._runTask("temp_progress", {});
    },

    async cleanupTemp() {
      return this._runTask("cleanup_temp", {});
    },

    // Resolve a list of names → existing IDs in Stash, creating missing ones.
    // Used for tags, performers, studios.
    async _resolveOrCreate(names, findQuery, findKey, createMutation) {
      const resolved = [];
      for (const raw of names) {
        const name = (raw || "").trim();
        if (!name) continue;
        try {
          const r = await this._client.query({ query: findQuery, variables: { q: name }, fetchPolicy: "network-only" });
          const list = (r.data && r.data[Object.keys(r.data)[0]] && r.data[Object.keys(r.data)[0]][findKey]) || [];
          // Case-insensitive exact match first.
          const exact = list.find(x => x.name.toLowerCase() === name.toLowerCase());
          if (exact) { resolved.push({ id: exact.id, name: exact.name, created: false }); continue; }
        } catch (e) { logError("resolve find", e, { name }); }
        // Not found → create.
        try {
          const r = await this._client.mutate({ mutation: createMutation, variables: { input: { name } } });
          const created = r.data && r.data[Object.keys(r.data)[0]];
          if (created) resolved.push({ id: created.id, name: created.name, created: true });
        } catch (e) { logError("resolve create", e, { name }); }
      }
      return resolved;
    },

    // After scan completes, find the just-imported items by path and apply
    // tags/performers/studio + optionally create a gallery.
    async applyPostImportMetadata({ destPath, tags, performers, studio, galleryTitle, makeGallery }) {
      const summary = { tags: [], performers: [], studio: null, gallery: null, taggedImages: 0, taggedScenes: 0, errors: [] };

      const tagIds = (await this._resolveOrCreate(tags || [], FIND_TAGS, "tags", TAG_CREATE)).map(x => x.id);
      summary.tags = tagIds;
      const perfIds = (await this._resolveOrCreate(performers || [], FIND_PERFORMERS, "performers", PERFORMER_CREATE)).map(x => x.id);
      summary.performers = perfIds;
      let studioId = null;
      if (studio && studio.trim()) {
        const r = await this._resolveOrCreate([studio.trim()], FIND_STUDIOS, "studios", STUDIO_CREATE);
        studioId = (r[0] && r[0].id) || null;
      }
      summary.studio = studioId;

      // Find imported items by path-includes filter.  Wait briefly so the
      // metadataScan job has a head-start on inserting rows.
      await new Promise(r => setTimeout(r, 1500));
      let imageIds = [];
      let sceneIds = [];
      try {
        const ir = await this._client.query({ query: FIND_IMAGES_BY_PATH, variables: { path: destPath }, fetchPolicy: "network-only" });
        imageIds = ((ir.data.findImages && ir.data.findImages.images) || []).map(i => i.id);
      } catch (e) { logError("findImages", e); summary.errors.push("find images: " + (e.message || e)); }
      try {
        const sr = await this._client.query({ query: FIND_SCENES_BY_PATH, variables: { path: destPath }, fetchPolicy: "network-only" });
        sceneIds = ((sr.data.findScenes && sr.data.findScenes.scenes) || []).map(s => s.id);
      } catch (e) { logError("findScenes", e); summary.errors.push("find scenes: " + (e.message || e)); }

      const updateInput = {};
      if (tagIds.length)  updateInput.tag_ids       = { mode: "ADD", ids: tagIds };
      if (perfIds.length) updateInput.performer_ids = { mode: "ADD", ids: perfIds };
      if (studioId)       updateInput.studio_id     = studioId;

      if (Object.keys(updateInput).length > 0) {
        if (imageIds.length) {
          try {
            await this._client.mutate({ mutation: BULK_IMAGE_UPDATE, variables: { input: { ...updateInput, ids: imageIds } } });
            summary.taggedImages = imageIds.length;
          } catch (e) { logError("bulkImageUpdate", e); summary.errors.push("bulk image: " + (e.message || e)); }
        }
        if (sceneIds.length) {
          try {
            await this._client.mutate({ mutation: BULK_SCENE_UPDATE, variables: { input: { ...updateInput, ids: sceneIds } } });
            summary.taggedScenes = sceneIds.length;
          } catch (e) { logError("bulkSceneUpdate", e); summary.errors.push("bulk scene: " + (e.message || e)); }
        }
      }

      if (makeGallery && imageIds.length > 0 && galleryTitle && galleryTitle.trim()) {
        try {
          const galInput = { title: galleryTitle.trim() };
          if (perfIds.length) galInput.performer_ids = perfIds;
          if (tagIds.length)  galInput.tag_ids       = tagIds;
          if (studioId)       galInput.studio_id     = studioId;
          const gr = await this._client.mutate({ mutation: GALLERY_CREATE, variables: { input: galInput } });
          const gid = gr.data && gr.data.galleryCreate && gr.data.galleryCreate.id;
          if (gid) {
            await this._client.mutate({ mutation: ADD_GALLERY_IMAGES, variables: { gallery_id: gid, image_ids: imageIds } });
            summary.gallery = { id: gid, title: galInput.title, image_count: imageIds.length };
          }
        } catch (e) { logError("galleryCreate", e); summary.errors.push("gallery: " + (e.message || e)); }
      }

      return summary;
    },

    async listFiles(path) {
      // Backend doesn't pre-assign IDs; synthesize stable-per-render keys.
      const items = await this._runTask("list", { path });
      return items.map((it, idx) => Object.assign({ id: it.path || (path + "#" + idx) }, it));
    },

    async search(query, path) {
      const items = await this._runTask("find", { query, path: path || "/" });
      return items.map((it, idx) => Object.assign({ id: it.path || ("search#" + idx) }, it));
    },

    // Chunks imports one file per backend task and runs up to `concurrency`
    // tasks in flight at once. Calls onProgress({ completed, total, inFlight,
    // lastResult }) as files complete. AbortSignal stops dispatching new files
    // and waits for in-flight tasks to settle (mid-file cancel would require
    // killing the mega-get subprocess which we don't do).
    // Idempotently add `path` to Stash's library paths so future scans (and
    // the one we trigger after import) actually pick up files there.
    // Stash's StashConfigInput REQUIRES path + excludeImage + excludeVideo;
    // omitting them silently drops the entry without raising.
    async ensureInLibrary(path) {
      try {
        const cfg = await this._client.query({ query: QUERY_CONFIG, fetchPolicy: "network-only" });
        const stashes = (cfg && cfg.data && cfg.data.configuration && cfg.data.configuration.general && cfg.data.configuration.general.stashes) || [];
        const already = stashes.some(s => s && s.path === path);
        if (already) {
          console.log(`[mega-import] ${path} already in Stash library paths (${stashes.length} total)`);
          return { added: false, alreadyPresent: true };
        }
        // Preserve existing stash entries, append the new one.
        const newStashes = stashes
          .map(s => ({ path: s.path, excludeImage: !!s.excludeImage, excludeVideo: !!s.excludeVideo }))
          .concat([{ path, excludeImage: false, excludeVideo: false }]);
        const res = await this._client.mutate({
          mutation: CONFIGURE_GENERAL,
          variables: { input: { stashes: newStashes } },
        });
        const finalPaths = (res && res.data && res.data.configureGeneral && res.data.configureGeneral.stashes || []).map(s => s.path);
        if (!finalPaths.includes(path)) {
          throw new Error(`Stash accepted the mutation but ${path} is not in the resulting stashes list (got ${finalPaths.join(", ") || "none"})`);
        }
        console.log(`[mega-import] added ${path} to Stash library paths (now ${finalPaths.length} total)`);
        return { added: true, alreadyPresent: false };
      } catch (e) {
        logError("ensureInLibrary", e, { path });
        return { added: false, error: e.message || String(e) };
      }
    },

    async downloadFiles(paths, destOverride, onProgress, signal, concurrency, opts) {
      const options = opts || {};
      // Normalize: accept either ["a/b/c.jpg"] or [{path:"a/b/c.jpg", size:12345}].
      // Size is used to compute a per-file timeout (slow connection-tolerant).
      const items = paths.map(p => typeof p === "string"
        ? { path: p, size: undefined, destFilename: undefined }
        : { path: p.path, size: p.size, destFilename: p.destFilename });
      const total = items.length;
      const conc = Math.max(1, Math.min(concurrency || 1, MAX_CONCURRENCY));
      const allItems = [];
      let resolvedDest = null;
      let nextIndex = 0;
      let completed = 0;
      let inFlight = 0;

      const downloadOne = async (item) => {
        const taskArgs = { paths: [item.path] };
        if (destOverride) taskArgs.dest = destOverride;
        if (item.destFilename) taskArgs.dest_filename = item.destFilename;
        try {
          // Pass size hint so _runTask scales the timeout (≥2 min, ~1s per 200KB).
          const resp = await this._runTask("download", taskArgs, item.size);
          if (resp.dest && !resolvedDest) resolvedDest = resp.dest;
          return (resp.items && resp.items[0]) || { path: item.path, status: "error", error: "no result" };
        } catch (e) {
          return { path: item.path, status: "error", error: e.message || String(e) };
        }
      };

      const worker = async () => {
        while (true) {
          if (signal && signal.aborted) return;
          const myIndex = nextIndex++;
          if (myIndex >= total) return;
          const item = items[myIndex];
          const filePath = item.path;
          inFlight++;
          if (onProgress) onProgress({ completed, total, inFlight, current: filePath, lastResult: null });

          const itemResult = await downloadOne(item);
          allItems.push(itemResult);
          inFlight--;
          completed++;

          // Record live so the "imported" indicator updates as we go.
          HistoryStore.record([{
            path: itemResult.path,
            dest: resolvedDest,
            status: itemResult.status,
            ts: Date.now(),
            error: itemResult.error || null,
          }]);

          if (onProgress) onProgress({ completed, total, inFlight, current: null, lastResult: itemResult });
        }
      };

      // Spin up workers; await all to drain.
      await Promise.all(Array.from({ length: Math.min(conc, total) }, () => worker()));

      const ok = allItems.filter(i => i.status === "ok");

      // Optionally make sure the dest is registered as a Stash library path.
      // Otherwise metadataScan silently does nothing for paths outside any library.
      let libraryAdded = false;
      let libraryError = null;
      if (ok.length > 0 && resolvedDest && options.autoAddToLibrary !== false) {
        const res = await this.ensureInLibrary(resolvedDest);
        libraryAdded = !!res.added;
        if (res.error) libraryError = res.error;
      }

      // Trigger Stash to scan the destination so imported files appear in the
      // library. Done once at the end, not per-file, to avoid scan thrash.
      let scanError = null;
      if (ok.length > 0 && resolvedDest) {
        try {
          await this._client.mutate({
            mutation: METADATA_SCAN,
            variables: { input: { paths: [resolvedDest] } },
          });
        } catch (e) {
          logError("metadataScan", e, { dest: resolvedDest });
          scanError = e.message || String(e);
        }
      }

      // Optionally trigger metadata generation (thumbnails, sprites, etc.).
      if (ok.length > 0 && options.generateAfterScan) {
        try {
          await this._client.mutate({
            mutation: METADATA_GENERATE,
            variables: { input: { sprites: true, previews: true, imagePreviews: true, markers: false, transcodes: false, phashes: true } },
          });
        } catch (e) { logError("metadataGenerate", e); }
      }

      // Auto-Tag (filename-based matching against existing performers/tags/studios).
      // Works on both scenes AND images. Cheap, no external API hits.
      let autoTagJob = null;
      if (ok.length > 0 && resolvedDest && options.autoTagAfterImport) {
        try {
          const r = await this._client.mutate({
            mutation: METADATA_AUTOTAG,
            // "*" = include all known performers/studios/tags as match candidates.
            variables: { input: { paths: [resolvedDest], performers: ["*"], studios: ["*"], tags: ["*"] } },
          });
          autoTagJob = r && r.data && r.data.metadataAutoTag;
        } catch (e) { logError("metadataAutoTag", e); }
      }

      // Identify against TPDB + StashDB stashboxes (scenes only — Stash ignores
      // images for identify). Only fires if at least one stashbox is configured.
      let identifyJob = null;
      if (ok.length > 0 && resolvedDest && options.identifyAfterImport) {
        try {
          const cfg = await this._client.query({ query: QUERY_CONFIG, fetchPolicy: "network-only" });
          // QUERY_CONFIG only fetches stashes; need stashBoxes too. Re-query.
          const sbResp = await this._client.query({
            query: gql`{ configuration { general { stashBoxes { endpoint } } } }`,
            fetchPolicy: "network-only",
          });
          const stashBoxes = (sbResp.data && sbResp.data.configuration && sbResp.data.configuration.general && sbResp.data.configuration.general.stashBoxes) || [];
          if (stashBoxes.length > 0) {
            const sources = stashBoxes.map(sb => ({ source: { stash_box_endpoint: sb.endpoint } }));
            const r = await this._client.mutate({
              mutation: METADATA_IDENTIFY,
              variables: { input: { paths: [resolvedDest], sources } },
            });
            identifyJob = r && r.data && r.data.metadataIdentify;
          } else {
            console.log("[mega-import] identify skipped — no stashBoxes configured");
          }
        } catch (e) { logError("metadataIdentify", e); }
      }

      return {
        imported: ok.length,
        dest: resolvedDest,
        scanError,
        libraryAdded,
        libraryError,
        autoTagJob,
        identifyJob,
        cancelled: !!(signal && signal.aborted),
        items: allItems.map(i => ({
          name: i.path,
          status: i.status === "ok" ? "Success" : ("Failed: " + (i.error || "unknown")),
        })),
      };
    },

    async logout() {
      try { await this._runTask("logout", {}); }
      catch (e) { logError("logout", e); /* clear local state regardless */ }
      this._session = null;
      this._emitSessionChange();
    },
  };

  MegaApiClient._hydrateSession();

  // Captures the Apollo client into MegaApiClient so non-React code can run
  // queries. Mounted inside NavbarPlugin.
  const ApolloCapture = () => {
    const client = useApolloClient();
    React.useEffect(() => { MegaApiClient._setApolloClient(client); }, [client]);
    return null;
  };

  // Cross-component signal: ask the navbar to pop the login modal.
  const requestLogin = () => window.dispatchEvent(new CustomEvent(OPEN_LOGIN_EVENT));

  // useSession — subscribe a component to MegaApiClient session changes.
  const useSession = () => {
    const [session, setSession] = React.useState(MegaApiClient.getSession());
    React.useEffect(() => MegaApiClient.onSessionChange(setSession), []);
    return session;
  };

  // NavButton — click opens login modal when logged out, jumps to /mega-browser when logged in.
  const NavButton = ({ onOpenLogin }) => {
    const session = useSession();
    const onClick = () => {
      if (session) {
        navigateTo("/mega-browser");
      } else {
        onOpenLogin();
      }
    };
    return React.createElement(Button, {
      className: "nav-utility minimal",
      title: session ? "MEGA Browser" : "MEGA Import — Log in",
      onClick,
      dangerouslySetInnerHTML: { __html: megaLogoSVG },
    });
  };

  // LoginModal — two modes: email/password or session token (API key).
  const LoginModal = ({ show, onClose, onLoggedIn }) => {
    const [mode, setMode] = React.useState("credentials"); // "credentials" | "token"
    const [email, setEmail] = React.useState("");
    const [password, setPassword] = React.useState("");
    const [tokenInput, setTokenInput] = React.useState("");
    const [isLoading, setIsLoading] = React.useState(false);
    const [errorMsg, setErrorMsg] = React.useState(null);
    const [savedToken, setSavedToken] = React.useState(null); // shown after creds login
    const [elapsed, setElapsed] = React.useState(0); // seconds since login started
    const toast = api.hooks.useToast();

    // Tick elapsed counter while loading so user sees progress.
    React.useEffect(() => {
      if (!isLoading) { setElapsed(0); return; }
      const id = setInterval(() => setElapsed(s => s + 1), 1000);
      return () => clearInterval(id);
    }, [isLoading]);

    const reset = () => {
      setEmail(""); setPassword(""); setTokenInput("");
      setErrorMsg(null); setSavedToken(null);
    };

    const handleClose = () => {
      if (isLoading) return;
      reset();
      onClose();
    };

    const handleSubmitCredentials = async (e) => {
      if (e && e.preventDefault) e.preventDefault();
      if (!email || !password) { setErrorMsg("Enter your email and password."); return; }
      setIsLoading(true); setErrorMsg(null);
      try {
        const session = await MegaApiClient.login(email, password);
        // Show the token for the user to copy before navigating away.
        if (session.sessionToken) { setSavedToken(session.sessionToken); return; }
        toast.success("Logged in to MEGA");
        reset(); onClose(); onLoggedIn();
      } catch (err) {
        const msg = (err && err.message) || "Unknown error";
        setErrorMsg("Login failed: " + msg);
        toast.error("MEGA login failed: " + msg);
      } finally { setIsLoading(false); }
    };

    const handleSubmitToken = async (e) => {
      if (e && e.preventDefault) e.preventDefault();
      const t = tokenInput.trim();
      if (!t) { setErrorMsg("Paste your session token."); return; }
      setIsLoading(true); setErrorMsg(null);
      try {
        await MegaApiClient.loginWithToken(t);
        toast.success("Logged in to MEGA");
        reset(); onClose(); onLoggedIn();
      } catch (err) {
        const msg = (err && err.message) || "Unknown error";
        setErrorMsg("Token rejected: " + msg);
        toast.error("MEGA token login failed: " + msg);
      } finally { setIsLoading(false); }
    };

    const handleContinueAfterToken = () => {
      reset(); onClose(); onLoggedIn();
    };

    // Token display after successful credentials login
    if (savedToken) {
      return React.createElement(
        Modal,
        { show, onHide: handleClose, size: "md" },
        React.createElement(Modal.Header, { closeButton: true },
          React.createElement("div", { className: "modal-title-with-logo" },
            React.createElement("span", { dangerouslySetInnerHTML: { __html: megaLogoSVGLarge }, className: "mega-logo-header" }),
            React.createElement(Modal.Title, null, "Logged in!")
          )
        ),
        React.createElement(Modal.Body, null,
          React.createElement(Alert, { variant: "success" }, "✓ Logged in to MEGA successfully."),
          React.createElement("p", { className: "small text-muted mb-1" },
            "Save this session token to log in next time without your password:"
          ),
          React.createElement(Form.Control, {
            as: "textarea", rows: 3, readOnly: true,
            value: savedToken,
            className: "mb-2 font-monospace small",
            onClick: (e) => e.target.select(),
          }),
          React.createElement("small", { className: "text-muted" },
            "Click the token to select it, then copy. Keep it secret — it grants full MEGA access."
          )
        ),
        React.createElement(Modal.Footer, null,
          React.createElement(Button, { variant: "primary", onClick: handleContinueAfterToken },
            "Continue to MEGA Browser"
          )
        )
      );
    }

    return React.createElement(
      Modal,
      { show, onHide: handleClose, size: "md" },
      React.createElement(
        Modal.Header,
        { closeButton: !isLoading },
        React.createElement(
          "div",
          { className: "modal-title-with-logo" },
          React.createElement("span", {
            dangerouslySetInnerHTML: { __html: megaLogoSVGLarge },
            className: "mega-logo-header",
          }),
          React.createElement(Modal.Title, null, "MEGA Cloud — Sign in")
        )
      ),
      React.createElement(
        Modal.Body,
        null,
        // Mode toggle
        React.createElement(
          "div",
          { className: "d-flex gap-2 mb-3" },
          React.createElement(Button, {
            variant: mode === "credentials" ? "primary" : "outline-secondary",
            size: "sm",
            onClick: () => { setMode("credentials"); setErrorMsg(null); },
            disabled: isLoading,
          }, "Email / Password"),
          React.createElement(Button, {
            variant: mode === "token" ? "primary" : "outline-secondary",
            size: "sm",
            onClick: () => { setMode("token"); setErrorMsg(null); },
            disabled: isLoading,
          }, "Session Token")
        ),
        errorMsg && React.createElement(Alert, { variant: "danger" }, errorMsg),
        mode === "credentials"
          ? React.createElement(
              Form,
              { onSubmit: handleSubmitCredentials },
              React.createElement(Form.Group, { className: "mb-3" },
                React.createElement(Form.Label, null, "Email"),
                React.createElement(Form.Control, {
                  type: "email", value: email,
                  onChange: (e) => setEmail(e.target.value),
                  placeholder: "your@email.com", disabled: isLoading, autoFocus: true,
                })
              ),
              React.createElement(Form.Group, { className: "mb-3" },
                React.createElement(Form.Label, null, "Password"),
                React.createElement(Form.Control, {
                  type: "password", value: password,
                  onChange: (e) => setPassword(e.target.value),
                  placeholder: "MEGA password", disabled: isLoading,
                })
              ),
              React.createElement("small", { className: "text-muted d-block mt-2" },
                "⚠ First login solves a server challenge — may take 2–5 min. ",
                "Copy the session token shown afterwards for instant re-login."
              ),
              React.createElement("button", { type: "submit", style: { display: "none" } })
            )
          : React.createElement(
              Form,
              { onSubmit: handleSubmitToken },
              React.createElement(Form.Group, { className: "mb-2" },
                React.createElement(Form.Label, null, "Session Token"),
                React.createElement(Form.Control, {
                  as: "textarea", rows: 3, value: tokenInput,
                  onChange: (e) => setTokenInput(e.target.value),
                  placeholder: "Paste the session token obtained after a previous login…",
                  disabled: isLoading, autoFocus: true,
                  className: "font-monospace small",
                })
              ),
              React.createElement("small", { className: "text-muted" },
                "A session token is shown once after email/password login."
              ),
              React.createElement("button", { type: "submit", style: { display: "none" } })
            )
      ),
      React.createElement(
        Modal.Footer,
        null,
        React.createElement(Button, { variant: "secondary", onClick: handleClose, disabled: isLoading }, "Cancel"),
        React.createElement(
          Button,
          {
            variant: "primary",
            onClick: mode === "credentials" ? handleSubmitCredentials : handleSubmitToken,
            disabled: isLoading,
          },
          isLoading
            ? [
                React.createElement(Icon, { icon: faSpinner, spin: true, key: "i" }),
                elapsed < 5
                  ? ` Signing in… ${elapsed}s`
                  : ` Solving proof-of-work… ${elapsed}s`
              ]
            : [React.createElement(Icon, { icon: faSignInAlt, key: "i" }), " Sign in"]
        )
      )
    );
  };

  // NavbarPlugin — owns the nav button + login modal.
  const NavbarPlugin = () => {
    const [showModal, setShowModal] = React.useState(false);

    React.useEffect(() => {
      const onOpen = () => setShowModal(true);
      window.addEventListener(OPEN_LOGIN_EVENT, onOpen);
      return () => window.removeEventListener(OPEN_LOGIN_EVENT, onOpen);
    }, []);

    return React.createElement(
      React.Fragment,
      null,
      React.createElement(ApolloCapture, null),
      React.createElement(NavButton, { onOpenLogin: () => setShowModal(true) }),
      React.createElement(LoginModal, {
        show: showModal,
        onClose: () => setShowModal(false),
        onLoggedIn: () => navigateTo("/mega-browser"),
      })
    );
  };

  // HistoryView — read-only list of past imports with filter + status filter.
  const HistoryView = () => {
    const history = useHistory();
    const entries = history.entries || [];
    const [filter, setFilter] = React.useState("");
    const [statusFilter, setStatusFilter] = React.useState("all"); // all | ok | err

    const fmtTime = (ts) => {
      try { return new Date(ts).toLocaleString(); }
      catch (e) { return String(ts); }
    };

    const filtered = React.useMemo(() => {
      const q = filter.trim().toLowerCase();
      return entries.filter(e => {
        if (statusFilter === "ok" && e.status !== "ok") return false;
        if (statusFilter === "err" && e.status === "ok") return false;
        if (q && !(e.path || "").toLowerCase().includes(q)) return false;
        return true;
      });
    }, [entries, filter, statusFilter]);

    return React.createElement(
      "div",
      null,
      React.createElement(
        "div",
        { className: "d-flex justify-content-between align-items-center mb-2" },
        React.createElement(
          "h5",
          { className: "m-0" },
          `Import history (${filtered.length}${filtered.length !== entries.length ? " of " + entries.length : ""})`
        ),
        entries.length > 0 && React.createElement(
          Button,
          {
            variant: "outline-danger",
            size: "sm",
            onClick: () => { if (window.confirm("Clear import history?")) HistoryStore.clear(); },
          },
          "Clear history"
        )
      ),
      entries.length > 0 && React.createElement(
        InputGroup,
        { className: "mb-2", size: "sm" },
        React.createElement(InputGroup.Text, null, React.createElement(Icon, { icon: faFilter })),
        React.createElement(Form.Control, {
          type: "text",
          value: filter,
          onChange: (e) => setFilter(e.target.value),
          placeholder: "Filter by path…",
        }),
        React.createElement(
          Form.Control,
          {
            as: "select",
            value: statusFilter,
            onChange: (e) => setStatusFilter(e.target.value),
            style: { maxWidth: "160px" },
          },
          React.createElement("option", { value: "all" }, "All statuses"),
          React.createElement("option", { value: "ok" }, "Successful only"),
          React.createElement("option", { value: "err" }, "Failed only")
        )
      ),
      filtered.length === 0
        ? React.createElement("p", { className: "text-muted m-0" },
            entries.length === 0 ? "No imports yet." : "No entries match the filter.")
        : React.createElement(
            "div",
            { className: "mega-history-list" },
            filtered.slice(0, 100).map((e, idx) => React.createElement(
              "div",
              { key: idx, className: `mega-history-row ${e.status === "ok" ? "ok" : "err"}` },
              React.createElement("span", { className: "mega-history-time" }, fmtTime(e.ts)),
              React.createElement("span", { className: "mega-history-path" }, e.path),
              React.createElement("span", { className: "mega-history-status" }, e.status === "ok" ? "✓" : ("✗ " + (e.error || "failed")))
            )),
            filtered.length > 100 && React.createElement("p", { className: "text-muted small mt-2" }, `(showing 100 of ${filtered.length})`)
          )
    );
  };

  // MegaBrowserPage — the actual file browser. Single source of truth for
  // listing/import. Redirects to / and pops the login modal if not authenticated.
  const MegaBrowserPage = () => {
    const session = useSession();
    console.log("[mega-import] MegaBrowserPage render — session=", session,
      "sessionStorage=", (typeof sessionStorage !== "undefined" ? sessionStorage.getItem(SESSION_STORAGE_KEY) : null));
    const [files, setFiles] = React.useState([]);
    const [currentPath, setCurrentPath] = React.useState("/");
    const [selectedItems, setSelectedItems] = React.useState([]);
    const [isLoading, setIsLoading] = React.useState(false);
    const [errorMsg, setErrorMsg] = React.useState(null);
    const [results, setResults] = React.useState(null);
    const [showSettings, setShowSettings] = React.useState(false);
    const [showHistory, setShowHistory] = React.useState(false);
    const [settings, setSettings] = useLocalStorage(SETTINGS_STORAGE_KEY, DEFAULT_SETTINGS);
    const [searchQuery, setSearchQuery] = React.useState("");
    const [searchResults, setSearchResults] = React.useState(null); // null = browse mode
    const [progress, setProgress] = React.useState(null); // {completed, total, current} during import
    const [progressRows, setProgressRows] = React.useState([]); // per-file rows: {path, status: pending|downloading|ok|err, error?, size?, startedAt?, realBytes?}
    // Tick + temp-file polling: every 2s, ask the backend for current sizes of
    // /tmp/megapy_* and match each in-flight download to its temp file by
    // (a) creation time roughly aligned with row.startedAt and
    // (b) growing toward but not exceeding row.size.  When matched, we use
    // the REAL on-disk byte count instead of the time-based estimate.
    React.useEffect(() => {
      const anyActive = progressRows.some(r => r.status === "downloading");
      if (!anyActive) return;
      let cancelled = false;

      const poll = async () => {
        try {
          const resp = await MegaApiClient.tempProgress();
          if (cancelled) return;
          const tempFiles = resp.files || [];
          const serverNow = resp.now || (Date.now() / 1000);

          setProgressRows(prev => {
            // Build matching: for each downloading row, find best temp file.
            // Strategy: temp files sorted by mtime asc; assign to downloading
            // rows sorted by startedAt asc.  This pairs N concurrent rows
            // with N temp files in creation order.  Within that, prefer files
            // whose size doesn't exceed the row's expected size.
            const downloading = prev
              .map((r, i) => ({ r, i }))
              .filter(o => o.r.status === "downloading")
              .sort((a, b) => (a.r.startedAt || 0) - (b.r.startedAt || 0));

            const sortedTemps = [...tempFiles]
              .filter(t => t.age_s < 30)              // active = touched in last 30s
              .sort((a, b) => a.mtime - b.mtime);

            const next = prev.slice();
            const used = new Set();
            for (const { r, i } of downloading) {
              // Find the first unused temp file whose size is plausible (≤ expected size + 10%).
              let pick = null;
              for (const t of sortedTemps) {
                if (used.has(t.name)) continue;
                if (r.size && t.size > r.size * 1.1) continue;
                pick = t;
                break;
              }
              if (pick) {
                used.add(pick.name);
                next[i] = { ...r, realBytes: pick.size };
              }
            }
            return next;
          });
        } catch (e) {
          // Silent — polling failure isn't worth alarming the user.
          console.warn("[mega-import] temp_progress poll failed:", e.message);
        }
      };

      // Fire immediately + every 2s.
      poll();
      const id = setInterval(poll, 2000);
      return () => { cancelled = true; clearInterval(id); };
    }, [progressRows.map(r => r.status).join(",")]);
    // Pre-import preview modal state.
    // null = no modal; otherwise { loading, manifest, excluded: Set<path>, excludeExts: Set<ext> }
    const [previewState, setPreviewState] = React.useState(null);
    // Pagination + sort: defaults from user settings; smallest folders first.
    const PAGE_SIZE = settings.pageSize || 10;
    const [pageLimit, setPageLimit] = React.useState(PAGE_SIZE);
    const [sortMode, setSortMode] = React.useState(settings.defaultSort || "size_asc"); // size_asc | size_desc | name | count_asc
    // Per-tile name expansion (truncated by default).
    const [expandedNames, setExpandedNames] = React.useState(() => new Set());
    const toggleNameExpansion = (path) => setExpandedNames(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
    const abortRef = React.useRef(null);
    const importedSet = useImportedSet();
    const toast = api.hooks.useToast();

    // While searching, the results replace the file listing. currentPath is
    // preserved so "clear search" returns the user to where they were.
    const displayFiles = searchResults !== null ? searchResults : files;

    const filteredFiles = React.useMemo(
      () => displayFiles.filter(f => matchesFilter(f, settings.filter, settings.customExts)),
      [displayFiles, settings.filter, settings.customExts]
    );

    // Sort: folders always come before files; within each group, apply the
    // chosen mode.  Folders use total_size / child_count from the backend.
    const sortedFiles = React.useMemo(() => {
      const folderKey = (f) => {
        if (sortMode === "size_asc")  return [0, f.total_size || 0];
        if (sortMode === "size_desc") return [0, -(f.total_size || 0)];
        if (sortMode === "count_asc") return [0, f.child_count || 0];
        return [0, f.name.toLowerCase()];
      };
      const fileKey = (f) => {
        if (sortMode === "size_asc")  return [1, f.size || 0];
        if (sortMode === "size_desc") return [1, -(f.size || 0)];
        return [1, f.name.toLowerCase()];
      };
      const arr = filteredFiles.slice();
      arr.sort((a, b) => {
        const ka = a.type === "folder" ? folderKey(a) : fileKey(a);
        const kb = b.type === "folder" ? folderKey(b) : fileKey(b);
        if (ka[0] !== kb[0]) return ka[0] - kb[0];
        if (ka[1] < kb[1]) return -1;
        if (ka[1] > kb[1]) return 1;
        return 0;
      });
      return arr;
    }, [filteredFiles, sortMode]);

    // Paginate: only show first `pageLimit` items.
    const visibleFiles = React.useMemo(
      () => sortedFiles.slice(0, pageLimit),
      [sortedFiles, pageLimit]
    );
    const hasMore = sortedFiles.length > pageLimit;

    // Reset pagination when path / sort / filter changes.
    React.useEffect(() => { setPageLimit(PAGE_SIZE); }, [currentPath, sortMode, settings.filter, searchResults]);

    // Selectable = files OR folders (folders import recursively via mega-get).
    const visibleSelectablePaths = React.useMemo(
      () => visibleFiles.map(f => f.path),
      [visibleFiles]
    );

    // Redirect on unauthenticated visit (initial load OR logout-elsewhere).
    React.useEffect(() => {
      if (!session) {
        navigateTo("/");
        requestLogin();
      }
    }, [session]);

    const [isStale, setIsStale] = React.useState(false);
    // Tracks the most recent loadPath request so stale backend responses
    // (user navigated to a different folder while the prior list was in flight)
    // don't overwrite the current view.
    const activePathRef = React.useRef(null);

    const loadPath = React.useCallback(async (path) => {
      console.log("[mega-import] loadPath start path=", path);
      activePathRef.current = path;
      setErrorMsg(null);
      setCurrentPath(path);
      setSelectedItems([]);

      // Show cached items immediately if we have them — instant feedback while
      // the backend re-fetches in the background.
      const cached = PathCache.get(path);
      if (cached && Array.isArray(cached.items)) {
        console.log("[mega-import] loadPath cache hit path=", path, "count=", cached.items.length, "age=", Math.round((Date.now() - cached.ts) / 1000) + "s");
        setFiles(cached.items);
        setIsStale(true);
      } else {
        setFiles([]);
        setIsStale(false);
      }
      setIsLoading(true);

      try {
        const list = await MegaApiClient.listFiles(path);
        // Always cache, even if user navigated away — that future visit benefits.
        PathCache.set(path, list);
        if (activePathRef.current !== path) {
          console.log("[mega-import] loadPath stale response, dropping path=", path, "(now on", activePathRef.current, ")");
          return;
        }
        console.log("[mega-import] loadPath ok path=", path, "count=", (list && list.length) || 0);
        setFiles(list);
        setIsStale(false);
      } catch (error) {
        const msg = (error && error.message) || "Unknown error";
        console.error("[mega-import] loadPath failed path=", path, "error=", error);
        if (activePathRef.current !== path) return;
        if (!cached) setErrorMsg(`Failed to load "${path}": ${msg}`);
        else toast.error(`Refresh failed (${msg}) — showing cached data.`);
      } finally {
        if (activePathRef.current === path) setIsLoading(false);
      }
    }, [toast]);

    React.useEffect(() => {
      if (session) {
        // Drop stale entries on mount; cheap, runs once per page load.
        const removed = PathCache.prune();
        if (removed > 0) console.log("[mega-import] pruned", removed, "stale path-cache entries");
        loadPath("/");
      }
    }, [session, loadPath]);

    // Press Enter to open the (single) selected folder. Power-user shortcut.
    React.useEffect(() => {
      const onKey = (e) => {
        if (e.key !== "Enter") return;
        // Don't fire while typing in inputs.
        const tag = (e.target && e.target.tagName) || "";
        if (tag === "INPUT" || tag === "TEXTAREA" || e.target.isContentEditable) return;
        if (selectedItems.length !== 1) return;
        const path = selectedItems[0];
        const node = files.find(f => f.path === path);
        if (node && node.type === "folder") {
          e.preventDefault();
          setSelectedItems([]);
          loadPath(path);
        }
      };
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }, [selectedItems, files, loadPath]);

    const toggleItemSelection = (item) => {
      setSelectedItems(prev =>
        prev.includes(item.path) ? prev.filter(p => p !== item.path) : [...prev, item.path]
      );
    };

    // Actually run the import. `toImport` may be array of strings OR array of
    // {path, size} objects.  Sizes (when present) flow into per-file timeouts.
    // postActions is optional: { tags[], performers[], studio?, makeGallery, galleryTitle }
    const runImport = async (toImport, postActions) => {
      // Normalize to {path, size} objects.
      let items = toImport.map(x => typeof x === "string" ? { path: x, size: undefined } : x);

      let skipped = 0;
      if (settings.skipAlreadyImported) {
        const before = items.length;
        items = items.filter(it => !importedSet.has(it.path));
        skipped = before - items.length;
      }
      if (items.length === 0) {
        toast.error(skipped > 0
          ? `All ${skipped} selected item(s) already imported (toggle off in Settings to re-import)`
          : "Nothing to import");
        return;
      }
      if (skipped > 0) toast.success(`Skipping ${skipped} already-imported item(s)`);

      setIsLoading(true);
      setErrorMsg(null);
      setProgress({ completed: 0, total: items.length, current: null });
      // Seed the per-file row list — every selected file starts as 'pending'.
      // Carry size through so we can render a per-file progress bar + xx/yy MB.
      setProgressRows(items.map(it => ({ path: it.path, status: "pending", size: it.size })));
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const r = await MegaApiClient.downloadFiles(
          items,
          (settings.dest || "").trim() || null,
          (p) => {
            setProgress(p);
            // Update the row for whichever file changed state.
            setProgressRows(prev => {
              if (!p) return prev;
              const next = prev.slice();
              if (p.current) {
                const idx = next.findIndex(r => r.path === p.current && r.status === "pending");
                if (idx >= 0) next[idx] = { ...next[idx], status: "downloading", startedAt: Date.now() };
              }
              if (p.lastResult) {
                const idx = next.findIndex(r => r.path === p.lastResult.path);
                if (idx >= 0) {
                  next[idx] = {
                    ...next[idx],
                    path: p.lastResult.path,
                    status: p.lastResult.status === "ok" ? "ok" : "err",
                    error: p.lastResult.error || null,
                    warning: p.lastResult.warning || null,
                  };
                }
              }
              return next;
            });
          },
          controller.signal,
          settings.concurrency,
          {
            autoAddToLibrary: settings.autoAddToLibrary,
            generateAfterScan: settings.generateAfterScan,
            autoTagAfterImport: settings.autoTagAfterImport,
            identifyAfterImport: settings.identifyAfterImport,
          }
        );
        setResults(r);
        const failed = r.items.filter(i => !i.status.startsWith("Success")).length;
        if (r.cancelled) toast.error(`Cancelled — ${r.imported} of ${items.length} imported`);
        else if (failed > 0) toast.error(`${r.imported} imported, ${failed} failed`);
        else toast.success(`Imported ${r.imported} item(s) → ${r.dest || "default folder"}`);
        if (r.libraryAdded) toast.success(`Added ${r.dest} to Stash library paths`);
        if (r.libraryError) toast.error(`Couldn't auto-add to library: ${r.libraryError}`);
        if (r.scanError) toast.error(`Scan trigger failed: ${r.scanError}`);
        if (r.autoTagJob) toast.success(`Auto-Tag job queued (${r.autoTagJob})`);
        if (r.identifyJob) toast.success(`Identify (TPDB+StashDB) job queued (${r.identifyJob})`);

        // Apply user-chosen post-import metadata (tags / performers / studio / gallery).
        // Done in the foreground after the scan job is queued so newly-scanned items
        // can be looked up by path.
        if (postActions && r.dest && (postActions.tags.length || postActions.performers.length || postActions.studio || postActions.makeGallery)) {
          try {
            const meta = await MegaApiClient.applyPostImportMetadata({
              destPath: r.dest,
              tags: postActions.tags,
              performers: postActions.performers,
              studio: postActions.studio,
              galleryTitle: postActions.galleryTitle,
              makeGallery: postActions.makeGallery,
            });
            const bits = [];
            if (meta.taggedImages) bits.push(`${meta.taggedImages} image(s) tagged`);
            if (meta.taggedScenes) bits.push(`${meta.taggedScenes} scene(s) tagged`);
            if (meta.gallery) bits.push(`gallery "${meta.gallery.title}" with ${meta.gallery.image_count} image(s)`);
            if (bits.length) toast.success("Metadata: " + bits.join(", "));
            if (meta.errors.length) toast.error("Some metadata steps failed: " + meta.errors.join("; "));
          } catch (e) {
            toast.error(`Post-import metadata failed: ${e.message || e}`);
          }
        }
      } catch (error) {
        const msg = (error && error.message) || "Unknown error";
        setErrorMsg(`Import failed: ${msg}`);
        toast.error(`MEGA import failed: ${msg}`);
      } finally {
        setIsLoading(false);
        setProgress(null);
        // Keep progressRows visible so user sees final per-file outcomes;
        // the panel is hidden anyway when progress is null. They get cleared
        // at the next import.
        abortRef.current = null;
      }
    };

    // Entry point bound to the "Import Selected" button.
    // If any folder is selected, fetch a preview manifest first and let the
    // user confirm / exclude files. Pure-file selections skip straight to download.
    const handleImport = async () => {
      if (selectedItems.length === 0) {
        toast.error("Select files to import first");
        return;
      }
      const hasFolder = selectedItems.some(p => {
        const node = files.find(f => f.path === p);
        return node && node.type === "folder";
      });
      if (!hasFolder) {
        // Annotate with sizes from the current dir listing so per-file timeouts
        // scale with file size.
        const sizedItems = selectedItems.map(p => {
          const node = files.find(f => f.path === p);
          return { path: p, size: node ? node.size : undefined };
        });
        return runImport(sizedItems);
      }
      // Folder(s) selected → fetch preview manifest + auto-suggest metadata
      // from the first folder name.
      const firstFolder = selectedItems.find(p => {
        const node = files.find(f => f.path === p);
        return node && node.type === "folder";
      });
      const parsed = firstFolder ? parseFolderName(firstFolder) : {};
      const folderLeaf = firstFolder ? firstFolder.split("/").filter(Boolean).pop() : "";

      setPreviewState({
        loading: true, manifest: null,
        excluded: new Set(), excludeExts: new Set(),
        // Track which selected folders are in scope so the renamer can find
        // each file's "main folder" (its closest selected-folder ancestor).
        selectedFolders: selectedItems.filter(p => {
          const node = files.find(f => f.path === p);
          return node && node.type === "folder";
        }),
        post: {
          tagsText: "",
          performersText: (parsed.performers || []).join(", "),
          studioText: parsed.studio || "",
          galleryTitle: parsed.title || folderLeaf || "",
          makeGallery: false,
          renameFromFolder: false,
          parsedHints: parsed,
        },
      });
      try {
        const manifest = await MegaApiClient.previewExpansion(selectedItems);
        setPreviewState(prev => prev && ({ ...prev, loading: false, manifest }));
      } catch (e) {
        toast.error(`Preview failed: ${e.message || e}`);
        setPreviewState(null);
      }
    };

    // Called when user clicks "Confirm import" in the preview modal.
    const confirmPreviewImport = () => {
      if (!previewState || !previewState.manifest) return;
      const allFiles = previewState.manifest.files;
      const excluded = previewState.excluded;
      const excludeExts = previewState.excludeExts;
      // Pass {path, size} so each per-file download gets a size-scaled timeout.
      let finalItems = allFiles
        .filter(f => !excluded.has(f.path))
        .filter(f => !excludeExts.has(f.ext))
        .map(f => ({ path: f.path, size: f.size }));
      const post = previewState.post || {};

      // Optional folder-based rename:
      //   <mainfolder>_<sub1>_<sub2>_..._<NUM>.<ext>
      // where <mainfolder> is the leaf name of the closest selected folder
      // that is an ancestor of this file's path, and <NUM> is a per-prefix
      // counter so files in the same sub-tree get sequential numbers.
      if (post.renameFromFolder) {
        // Sort by selected-folder length DESC so deeper selections win when nested.
        const folders = (previewState.selectedFolders || [])
          .slice()
          .sort((a, b) => b.length - a.length);
        const counters = {};

        // Stable sort by path so numbering is deterministic.
        finalItems.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

        finalItems = finalItems.map(item => {
          // Find the deepest selected folder that is an ancestor.
          const root = folders.find(fp =>
            item.path === fp || item.path.startsWith(fp.endsWith("/") ? fp : fp + "/")
          );
          if (!root) return item;
          const mainFolderLeaf = (root.split("/").filter(Boolean).pop() || "folder");
          // Path relative to that selected folder.
          let rel = item.path.slice(root.length).replace(/^\/+/, "");
          // rel = "[<subdirs/>]<filename.ext>"
          const lastSlash = rel.lastIndexOf("/");
          const subdirParts = lastSlash >= 0 ? rel.slice(0, lastSlash).split("/").filter(Boolean) : [];
          const leaf = lastSlash >= 0 ? rel.slice(lastSlash + 1) : rel;
          const dot = leaf.lastIndexOf(".");
          const ext = dot > 0 ? leaf.slice(dot + 1) : "";
          // Build prefix: mainfolder + each sub-dir, joined by underscore.
          const prefix = [mainFolderLeaf, ...subdirParts].join("_");
          counters[prefix] = (counters[prefix] || 0) + 1;
          const num = String(counters[prefix]).padStart(3, "0");
          const newName = ext ? `${prefix}_${num}.${ext}` : `${prefix}_${num}`;
          return { ...item, destFilename: newName };
        });
      }

      const postActions = {
        tags: (post.tagsText || "").split(",").map(s => s.trim()).filter(Boolean),
        performers: (post.performersText || "").split(",").map(s => s.trim()).filter(Boolean),
        studio: (post.studioText || "").trim() || null,
        makeGallery: !!post.makeGallery,
        galleryTitle: (post.galleryTitle || "").trim(),
      };
      setPreviewState(null);
      runImport(finalItems, postActions);
    };

    const cancelImport = () => {
      if (abortRef.current) {
        abortRef.current.abort();
        toast.success("Cancelling after current file…");
      }
    };

    const selectAllVisible = () => {
      setSelectedItems(prev => Array.from(new Set([...prev, ...visibleSelectablePaths])));
    };

    const clearSelection = () => setSelectedItems([]);

    const handleSearch = async (q) => {
      const query = (q || "").trim();
      if (!query) {
        setSearchResults(null);
        return;
      }
      setIsLoading(true);
      setErrorMsg(null);
      try {
        const items = await MegaApiClient.search(query, "/");
        setSearchResults(items);
        setSelectedItems([]);
      } catch (error) {
        const msg = (error && error.message) || "Unknown error";
        setErrorMsg(`Search failed: ${msg}`);
        toast.error(`MEGA search failed: ${msg}`);
      } finally {
        setIsLoading(false);
      }
    };

    const clearSearch = () => {
      setSearchQuery("");
      setSearchResults(null);
      setSelectedItems([]);
    };

    const handleDisconnect = async () => {
      try {
        await MegaApiClient.logout();
        // Wipe browser-side caches so the next user doesn't see the previous account's tree.
        PathCache.clear();
        toast.success("Disconnected from MEGA");
        navigateTo("/");
      } catch (error) {
        const msg = (error && error.message) || "Unknown error";
        toast.error(`Logout failed: ${msg}`);
      }
    };

    const goUp = () => {
      const parent = currentPath.substring(0, currentPath.lastIndexOf("/")) || "/";
      loadPath(parent);
    };

    if (!session) {
      // Effect above is redirecting; render a visible placeholder so the user
      // knows the route mounted and isn't staring at a blank white page.
      return React.createElement(
        "div",
        { className: "mega-browser-page", style: { padding: "2rem", color: "#fff" } },
        React.createElement("h3", null, "MEGA Import"),
        React.createElement("p", null, "Not logged in. Opening login modal…"),
        React.createElement(
          Button,
          { variant: "primary", onClick: () => { requestLogin(); navigateTo("/"); } },
          "Open login"
        ),
        " ",
        React.createElement(
          Button,
          { variant: "outline-secondary", onClick: () => navigateTo("/") },
          "Back to Stash"
        )
      );
    }

    return React.createElement(
      "div",
      { className: "mega-browser-page" },
      React.createElement(
        "div",
        { className: "mega-browser-header" },
        React.createElement(
          "div",
          { className: "title-with-logo" },
          React.createElement("span", {
            dangerouslySetInnerHTML: { __html: megaLogoSVGLarge },
            className: "mega-logo-header",
          }),
          React.createElement(
            "div",
            null,
            React.createElement("h2", null, "MEGA Cloud Browser"),
            React.createElement("small", { className: "text-muted" }, session.email)
          )
        ),
        React.createElement(
          "div",
          { className: "mega-browser-actions" },
          React.createElement(
            Button,
            { variant: "secondary", onClick: () => navigateTo("/"), className: "mr-2" },
            React.createElement(Icon, { icon: faHome }),
            " Back to Stash"
          ),
          progress
            ? React.createElement(
                Button,
                { variant: "outline-warning", onClick: cancelImport, className: "mr-2" },
                React.createElement(Icon, { icon: faTimes }),
                ` Cancel (${progress.completed}/${progress.total})`
              )
            : React.createElement(
                Button,
                { variant: "primary", onClick: handleImport, disabled: isLoading || selectedItems.length === 0, className: "mr-2" },
                React.createElement(Icon, { icon: faCloudDownloadAlt }),
                ` Import Selected (${selectedItems.length})`
              ),
          React.createElement(
            Button,
            { variant: "outline-secondary", onClick: () => setShowHistory(s => !s), className: "mr-2", title: "Import history" },
            React.createElement(Icon, { icon: faHistory })
          ),
          React.createElement(
            Button,
            { variant: "outline-secondary", onClick: () => setShowSettings(s => !s), className: "mr-2", title: "Settings" },
            React.createElement(Icon, { icon: faCog })
          ),
          React.createElement(
            Button,
            { variant: "outline-danger", onClick: handleDisconnect, disabled: isLoading },
            React.createElement(Icon, { icon: faSignOutAlt }),
            " Disconnect"
          )
        )
      ),
      errorMsg && React.createElement(Alert, { variant: "danger" }, errorMsg),

      // Live import / download manager — header + scrollable per-file rows.
      progress && React.createElement(
        "div",
        { className: "mega-progress mb-3" },
        React.createElement(
          "div",
          { className: "mega-progress-label" },
          React.createElement(Icon, { icon: faSpinner, spin: true }),
          ` Importing ${progress.completed} / ${progress.total}`,
          progress.inFlight > 0 && React.createElement("span", { className: "mega-progress-inflight" }, ` (${progress.inFlight} in flight)`)
        ),
        React.createElement(
          "div",
          { className: "mega-progress-bar-outer" },
          React.createElement("div", {
            className: "mega-progress-bar-inner",
            style: { width: ((progress.completed / Math.max(progress.total, 1)) * 100) + "%" },
          })
        ),
        // Per-file rows. Active downloads float to the top so they're always visible.
        progressRows.length > 0 && React.createElement(
          "div",
          { className: "mega-progress-rows" },
          [...progressRows]
            .sort((a, b) => {
              const order = { downloading: 0, pending: 1, ok: 2, err: 3 };
              return (order[a.status] ?? 9) - (order[b.status] ?? 9);
            })
            .map((row, i) => {
              const icon = row.status === "downloading" ? faSpinner
                : row.status === "ok" ? faCheck
                : row.status === "err" ? faTimes
                : faFile;

              // Progress: prefer REAL bytes from the temp file on disk
              // (polled every 2s from /tmp/megapy_*).  Fall back to a time
              // estimate (200 KB/s assumed) for the seconds before the temp
              // file appears or when a poll hasn't landed yet.
              const ASSUMED_BPS = 200_000;
              let pct = 0;
              let bytesShown = 0;
              let isReal = false;
              if (row.status === "downloading" && row.size) {
                if (typeof row.realBytes === "number") {
                  bytesShown = row.realBytes;
                  pct = Math.min(99, (bytesShown / row.size) * 100);
                  isReal = true;
                } else if (row.startedAt) {
                  const elapsed = Math.max(0, (Date.now() - row.startedAt) / 1000);
                  bytesShown = Math.min(row.size, Math.floor(elapsed * ASSUMED_BPS));
                  pct = Math.min(95, (bytesShown / row.size) * 100);
                }
              } else if (row.status === "ok") {
                bytesShown = row.size || 0;
                pct = 100;
                isReal = true;
              }

              const sizeText = row.size
                ? (row.status === "downloading"
                    ? `${humanSize(bytesShown)} / ${humanSize(row.size)}${isReal ? "" : " ~"}`
                    : humanSize(row.size))
                : "";

              return React.createElement(
                "div",
                { key: i, className: `mega-progress-row mega-progress-row-${row.status}`, title: row.error || row.path },
                React.createElement(Icon, { icon, spin: row.status === "downloading" }),
                React.createElement("span", { className: "mega-progress-row-path" }, row.path),
                // Inline progress bar (estimated). Shown for downloading + ok rows.
                React.createElement(
                  "div",
                  { className: "mega-progress-row-bar-outer" },
                  React.createElement("div", {
                    className: "mega-progress-row-bar-inner",
                    style: { width: pct + "%" },
                  })
                ),
                React.createElement("span", { className: "mega-progress-row-size" }, sizeText),
                React.createElement("span", { className: "mega-progress-row-status" },
                  row.status === "ok" && (row.warning ? "✓ (mac-skipped)" : "✓"),
                  row.status === "err" && ("✗ " + (row.error || "failed")),
                  row.status === "downloading" && "downloading…",
                  row.status === "pending" && "queued"
                )
              );
            })
        )
      ),

      // Settings panel (collapsible)
      React.createElement(
        Collapse,
        { in: showSettings },
        React.createElement(
          "div",
          { className: "mega-settings-panel mb-3" },
          React.createElement("h5", null, "Settings"),

          // ---- Group: Destination & Stash integration ----
          React.createElement("h6", { className: "mega-settings-group" }, "Stash integration"),
          React.createElement(
            Form.Group,
            { className: "mb-3" },
            React.createElement(Form.Label, null, "Import destination (server-side path)"),
            React.createElement(Form.Control, {
              type: "text",
              value: settings.dest,
              onChange: (e) => setSettings({ dest: e.target.value }),
              placeholder: "Leave blank to use plugin default (~/.stash/mega_imports)",
            }),
            React.createElement(Form.Text, { className: "text-muted" },
              "Files land on the Stash server, not your browser. Default lives inside Stash's config directory.")
          ),
          React.createElement(Form.Check, {
            type: "switch", id: "mega-set-autoadd", className: "mb-2",
            label: "Auto-add destination to Stash library paths",
            checked: !!settings.autoAddToLibrary,
            onChange: (e) => setSettings({ autoAddToLibrary: e.target.checked }),
          }),
          React.createElement(Form.Check, {
            type: "switch", id: "mega-set-generate", className: "mb-2",
            label: "Generate metadata after scan (sprites, previews, pHash)",
            checked: !!settings.generateAfterScan,
            onChange: (e) => setSettings({ generateAfterScan: e.target.checked }),
          }),
          React.createElement(Form.Check, {
            type: "switch", id: "mega-set-autotag", className: "mb-2",
            label: "Auto-Tag after import (filename → existing performers/tags/studios)",
            checked: !!settings.autoTagAfterImport,
            onChange: (e) => setSettings({ autoTagAfterImport: e.target.checked }),
          }),
          React.createElement(Form.Check, {
            type: "switch", id: "mega-set-identify", className: "mb-2",
            label: "Identify after import (scrape TPDB + StashDB — scenes only)",
            checked: !!settings.identifyAfterImport,
            onChange: (e) => setSettings({ identifyAfterImport: e.target.checked }),
          }),
          React.createElement(Form.Check, {
            type: "switch", id: "mega-set-skip", className: "mb-3",
            label: "Skip files already imported (uses local history)",
            checked: !!settings.skipAlreadyImported,
            onChange: (e) => setSettings({ skipAlreadyImported: e.target.checked }),
          }),

          // ---- Group: Download behavior ----
          React.createElement("h6", { className: "mega-settings-group" }, "Downloads"),
          React.createElement(
            Form.Group,
            { className: "mb-3", style: { maxWidth: "260px" } },
            React.createElement(Form.Label, null, "Parallel downloads"),
            React.createElement(
              Form.Control,
              {
                as: "select",
                value: String(settings.concurrency),
                onChange: (e) => setSettings({ concurrency: parseInt(e.target.value, 10) || 1 }),
              },
              Array.from({ length: MAX_CONCURRENCY }, (_, i) => i + 1).map(n =>
                React.createElement("option", { key: n, value: String(n) }, n === 1 ? "1 (sequential)" : `${n} files at a time`)
              )
            ),
            React.createElement(Form.Text, { className: "text-muted" },
              "Higher = faster on large selections; lower = gentler on bandwidth.")
          ),

          // ---- Group: Browser display ----
          React.createElement("h6", { className: "mega-settings-group" }, "Browser display"),
          React.createElement(
            "div",
            { className: "d-flex gap-3 flex-wrap mb-2" },
            React.createElement(
              Form.Group,
              { style: { maxWidth: "180px" } },
              React.createElement(Form.Label, null, "Items per page"),
              React.createElement(
                Form.Control,
                {
                  as: "select",
                  value: String(settings.pageSize),
                  onChange: (e) => setSettings({ pageSize: parseInt(e.target.value, 10) || 10 }),
                },
                [5, 10, 20, 30, 50, 100].map(n =>
                  React.createElement("option", { key: n, value: String(n) }, String(n))
                )
              )
            ),
            React.createElement(
              Form.Group,
              { style: { maxWidth: "220px" } },
              React.createElement(Form.Label, null, "Default sort"),
              React.createElement(
                Form.Control,
                {
                  as: "select",
                  value: settings.defaultSort,
                  onChange: (e) => setSettings({ defaultSort: e.target.value }),
                },
                React.createElement("option", { value: "size_asc" }, "Smallest first"),
                React.createElement("option", { value: "size_desc" }, "Largest first"),
                React.createElement("option", { value: "count_asc" }, "Fewest items first"),
                React.createElement("option", { value: "name" }, "Name (A-Z)")
              )
            )
          ),

          // ---- Group: Cache management ----
          React.createElement("h6", { className: "mega-settings-group" }, "Cache"),
          React.createElement("p", { className: "text-muted small mb-2" },
            "Per-folder metadata is cached in your browser for 1 hour to make navigation instant."),
          React.createElement(
            Button,
            {
              variant: "outline-secondary", size: "sm",
              onClick: () => { PathCache.clear(); toast.success("Browser cache cleared"); },
            },
            "Clear browser folder cache"
          ),
          React.createElement(
            Button,
            {
              variant: "outline-warning", size: "sm", className: "ml-2",
              onClick: async () => {
                if (!window.confirm("Delete ALL /tmp/megapy_* files on the server? Will trash any download in flight.")) return;
                try {
                  const r = await MegaApiClient.cleanupTemp();
                  toast.success(`Deleted ${r.deleted} temp file(s) — freed ${humanSize(r.bytes_freed)}`);
                } catch (e) { toast.error(`Cleanup failed: ${e.message || e}`); }
              },
              title: "Server-side cleanup of orphan mega.py temp files",
            },
            "Clean server temp files"
          )
        )
      ),

      // History panel (collapsible)
      React.createElement(
        Collapse,
        { in: showHistory },
        React.createElement("div", { className: "mega-history-panel mb-3" },
          React.createElement(HistoryView, null)
        )
      ),

      // Search bar
      React.createElement(
        InputGroup,
        { className: "mega-search-group mb-2" },
        React.createElement(InputGroup.Text, null, React.createElement(Icon, { icon: faSearch })),
        React.createElement(Form.Control, {
          type: "text",
          value: searchQuery,
          onChange: (e) => setSearchQuery(e.target.value),
          onKeyDown: (e) => { if (e.key === "Enter") handleSearch(searchQuery); },
          placeholder: "Search MEGA tree (glob pattern, e.g. *.mp4) — Enter to search",
          disabled: isLoading,
        }),
        React.createElement(
          Button,
          { variant: "outline-secondary", onClick: () => handleSearch(searchQuery), disabled: isLoading || !searchQuery.trim() },
          "Search"
        ),
        searchResults !== null && React.createElement(
          Button,
          { variant: "outline-secondary", onClick: clearSearch, title: "Clear search" },
          React.createElement(Icon, { icon: faTimes })
        )
      ),
      searchResults !== null && React.createElement(
        Alert,
        { variant: "info", className: "py-1 px-2 mb-2" },
        `Search results for "${searchQuery}" — ${searchResults.length} match(es). Folder navigation paused.`
      ),

      // Breadcrumb navigation — each segment is clickable.
      React.createElement(
        "div",
        { className: "mega-breadcrumbs mb-2" },
        React.createElement(
          "span",
          { className: "mega-crumb", onClick: () => loadPath("/") },
          React.createElement(Icon, { icon: faHome }),
          " MEGA"
        ),
        ...(currentPath === "/" ? [] : currentPath.split("/").filter(Boolean).map((seg, idx, arr) => {
          const target = "/" + arr.slice(0, idx + 1).join("/");
          const isLast = idx === arr.length - 1;
          return React.createElement(
            React.Fragment,
            { key: target },
            React.createElement("span", { className: "mega-crumb-sep" }, " / "),
            isLast
              ? React.createElement("span", { className: "mega-crumb mega-crumb-current" }, seg)
              : React.createElement("span", { className: "mega-crumb", onClick: () => loadPath(target) }, seg)
          );
        })),
        React.createElement(
          "span",
          { className: "mega-crumb-counts" },
          ` — ${visibleFiles.filter(f => f.type === "folder").length} folder(s), ${visibleFiles.filter(f => f.type === "file").length} file(s)`
        ),
        isStale && isLoading && React.createElement(
          "span",
          { className: "mega-stale-badge", title: "Showing cached data while fetching fresh listing" },
          React.createElement(Icon, { icon: faSpinner, spin: true }),
          " refreshing…"
        )
      ),

      // Filter + selection toolbar
      React.createElement(
        "div",
        { className: "mega-toolbar mb-2" },
        React.createElement(
          InputGroup,
          { className: "mega-filter-group" },
          React.createElement(
            InputGroup.Text,
            null,
            React.createElement(Icon, { icon: faFilter })
          ),
          React.createElement(
            Form.Control,
            {
              as: "select",
              value: settings.filter,
              onChange: (e) => setSettings({ filter: e.target.value }),
            },
            React.createElement("option", { value: "all" }, "All files"),
            React.createElement("option", { value: "videos" }, "Videos only"),
            React.createElement("option", { value: "images" }, "Images only"),
            React.createElement("option", { value: "custom" }, "Custom extensions")
          ),
          settings.filter === "custom" && React.createElement(Form.Control, {
            type: "text",
            value: settings.customExts,
            onChange: (e) => setSettings({ customExts: e.target.value }),
            placeholder: "mp4, mkv, ts (comma-separated)",
          })
        ),
        React.createElement(
          "div",
          { className: "mega-toolbar-actions" },
          React.createElement(
            Form.Control,
            {
              as: "select", size: "sm", value: sortMode,
              onChange: (e) => setSortMode(e.target.value),
              style: { maxWidth: "180px" },
              title: "Sort folders and files",
            },
            React.createElement("option", { value: "size_asc" }, "Smallest first"),
            React.createElement("option", { value: "size_desc" }, "Largest first"),
            React.createElement("option", { value: "count_asc" }, "Fewest items first"),
            React.createElement("option", { value: "name" }, "Name (A-Z)")
          ),
          React.createElement(
            Button,
            { variant: "outline-secondary", size: "sm", onClick: selectAllVisible, disabled: visibleSelectablePaths.length === 0, className: "ml-2" },
            React.createElement(Icon, { icon: faCheckSquare }),
            " Select all visible"
          ),
          React.createElement(
            Button,
            { variant: "outline-secondary", size: "sm", onClick: clearSelection, disabled: selectedItems.length === 0, className: "ml-2" },
            React.createElement(Icon, { icon: faSquare }),
            " Clear"
          )
        )
      ),
      React.createElement(
        "div",
        { className: "mega-browser-content" },
        React.createElement(
          "div",
          { className: "files-container" },
          isLoading && files.length === 0 && React.createElement(
            "div",
            { className: "loader" },
            React.createElement(Icon, { icon: faSpinner, spin: true }),
            " Loading…"
          ),
          // Grid container — tiles flow N per row, wrapping naturally.
          React.createElement(
            "div",
            { className: "mega-tile-grid" },
            currentPath !== "/" && React.createElement(
              "div",
              { className: "mega-tile mega-tile-up", onClick: goUp, title: "Go up" },
              React.createElement(Icon, { icon: faFolder, className: "mega-tile-icon" }),
              React.createElement("div", { className: "mega-tile-name" }, ".. (up)")
            ),
            !isLoading && visibleFiles.length === 0 && React.createElement(
              "div",
              { className: "mega-empty-state" },
              files.length === 0
                ? "This folder is empty."
                : `No files match the current filter (${settings.filter}). ${files.length} hidden.`
            ),
            visibleFiles.map(file => {
              const isSelected = selectedItems.includes(file.path);
              const wasImported = importedSet.has(file.path);
              const isExpanded = expandedNames.has(file.path);
              // Click semantics (file-explorer style):
              //   - single click  → toggle selection (folder OR file)
              //   - double click  → navigate INTO folder (no-op for files)
              //   - click on name → toggle name expansion (long names)
              const onTileClick = (e) => {
                if (e.target.closest(".mega-tile-name")) {
                  e.stopPropagation();
                  toggleNameExpansion(file.path);
                  return;
                }
                toggleItemSelection(file);
              };
              const onTileDoubleClick = (e) => {
                if (file.type !== "folder") return;
                e.stopPropagation();
                // Selection toggled by single-click first; undo that so the
                // folder isn't accidentally selected after navigating in.
                setSelectedItems(prev => prev.filter(p => p !== file.path));
                // Double-click in search mode also navigates — clears the
                // search since we've left "result mode" by drilling into a folder.
                if (searchResults !== null) {
                  setSearchQuery("");
                  setSearchResults(null);
                }
                loadPath(file.path);
              };
              return React.createElement(
                "div",
                {
                  key: file.id,
                  className: `mega-tile mega-tile-${file.type}` +
                    (isSelected ? " selected" : "") +
                    (wasImported ? " imported" : ""),
                  onClick: onTileClick,
                  onDoubleClick: onTileDoubleClick,
                  title: file.type === "folder" ? `${file.name} — double-click to open` : file.name,
                },
                React.createElement(Form.Check, {
                  className: "mega-tile-check",
                  type: "checkbox",
                  checked: isSelected,
                  onChange: (e) => { e.stopPropagation(); toggleItemSelection(file); },
                  onClick: (e) => e.stopPropagation(),
                }),
                wasImported && React.createElement(
                  "span",
                  { className: "mega-tile-imported", title: "Previously imported" },
                  React.createElement(Icon, { icon: faCheck })
                ),
                React.createElement(Icon, {
                  icon: file.type === "folder" ? faFolder : faFile,
                  className: "mega-tile-icon"
                }),
                React.createElement(
                  "div",
                  {
                    className: "mega-tile-name" + (isExpanded ? " expanded" : " truncated"),
                  },
                  file.name
                ),
                React.createElement(
                  "div",
                  { className: "mega-tile-meta" },
                  file.type === "folder"
                    ? `${file.child_count || 0} item(s)${file.total_size ? " · " + humanSize(file.total_size) : ""}`
                    : (file.size != null ? humanSize(file.size) : "")
                ),
                searchResults !== null && React.createElement(
                  "div", { className: "mega-tile-path", title: file.path }, file.path
                )
              );
            })
          ),
          // Pagination — "Load more" button when there are more sorted items.
          hasMore && React.createElement(
            "div",
            { className: "mega-load-more" },
            React.createElement(
              Button,
              { variant: "outline-primary", size: "sm", onClick: () => setPageLimit(n => n + PAGE_SIZE) },
              `Show next ${Math.min(PAGE_SIZE, sortedFiles.length - pageLimit)} of ${sortedFiles.length - pageLimit} remaining`
            ),
            React.createElement(
              Button,
              { variant: "link", size: "sm", onClick: () => setPageLimit(sortedFiles.length), className: "ml-2" },
              "Show all"
            )
          )
        ),
        selectedItems.length > 0 && React.createElement(
          "div",
          { className: "selection-info mt-3" },
          React.createElement("span", null, `${selectedItems.length} item(s) selected`)
        ),
        results && React.createElement(
          "div",
          { className: "mega-results-panel mt-4" },
          React.createElement(
            "div",
            { className: "mega-results-header" },
            React.createElement("h5", { className: "m-0" },
              `Import Results — ${results.imported} ok / ${results.items.length - results.imported} failed`),
            React.createElement(
              Button,
              { variant: "outline-secondary", size: "sm", onClick: () => setResults(null) },
              "Dismiss"
            )
          ),
          results.dest && React.createElement("div", { className: "mega-results-dest" },
            "→ ", React.createElement("code", null, results.dest)
          ),
          React.createElement(
            "div",
            { className: "mega-results-list" },
            results.items.map((it, idx) => {
              const isOk = it.status && it.status.startsWith("Success");
              return React.createElement(
                "div",
                { key: idx, className: `mega-results-row ${isOk ? "ok" : "err"}` },
                React.createElement("span", { className: "mega-results-status" }, isOk ? "✓" : "✗"),
                React.createElement("span", { className: "mega-results-name", title: it.name }, it.name),
                React.createElement("span", { className: "mega-results-detail" }, it.status)
              );
            })
          )
        ),

        // ===== Preview / confirm modal for folder imports =====
        previewState && React.createElement(
          Modal,
          { show: true, onHide: () => setPreviewState(null), size: "lg" },
          React.createElement(
            Modal.Header,
            { closeButton: true },
            React.createElement(Modal.Title, null, "Confirm import")
          ),
          React.createElement(
            Modal.Body,
            null,
            previewState.loading
              ? React.createElement(
                  "div",
                  { className: "text-center py-3" },
                  React.createElement(Icon, { icon: faSpinner, spin: true }),
                  " Expanding folders…"
                )
              : (() => {
                  const m = previewState.manifest;
                  if (!m) return null;
                  const excluded = previewState.excluded;
                  const excludeExts = previewState.excludeExts;
                  // Compute live counts after exclusions.
                  const remainingFiles = m.files
                    .filter(f => !excluded.has(f.path))
                    .filter(f => !excludeExts.has(f.ext));
                  const remainingBytes = remainingFiles.reduce((a, f) => a + (f.size || 0), 0);
                  const alreadyImported = remainingFiles.filter(f => importedSet.has(f.path)).length;
                  return React.createElement(
                    React.Fragment,
                    null,
                    React.createElement(
                      "div",
                      { className: "mega-preview-summary" },
                      React.createElement("strong", null, `${remainingFiles.length}`),
                      ` of ${m.total_files} file(s) selected — `,
                      React.createElement("strong", null, humanSize(remainingBytes)),
                      ` of ${humanSize(m.total_size)}`,
                      settings.skipAlreadyImported && alreadyImported > 0 && React.createElement(
                        "div", { className: "small text-warning mt-1" },
                        `${alreadyImported} of those will be skipped — already imported (toggle off in Settings to re-download).`
                      )
                    ),

                    // ===== Post-import metadata section =====
                    React.createElement("h6", { className: "mt-3 mega-settings-group" }, "Post-import metadata"),
                    previewState.post && previewState.post.parsedHints && Object.keys(previewState.post.parsedHints).length > 0 && React.createElement(
                      "div",
                      { className: "small text-muted mb-2" },
                      "Detected from folder name: ",
                      Object.entries(previewState.post.parsedHints).map(([k, v]) =>
                        React.createElement("code", { key: k, className: "mr-2" },
                          `${k}=${Array.isArray(v) ? v.join("|") : v}`)
                      )
                    ),
                    React.createElement(
                      "div",
                      { className: "mega-preview-meta-grid" },
                      React.createElement(
                        Form.Group,
                        null,
                        React.createElement(Form.Label, null, "Tags (comma-separated)"),
                        React.createElement(Form.Control, {
                          type: "text", size: "sm",
                          value: (previewState.post && previewState.post.tagsText) || "",
                          onChange: (e) => setPreviewState(prev => ({ ...prev, post: { ...prev.post, tagsText: e.target.value } })),
                          placeholder: "e.g. milf, anal, hd",
                        })
                      ),
                      React.createElement(
                        Form.Group,
                        null,
                        React.createElement(Form.Label, null, "Performers (comma-separated)"),
                        React.createElement(Form.Control, {
                          type: "text", size: "sm",
                          value: (previewState.post && previewState.post.performersText) || "",
                          onChange: (e) => setPreviewState(prev => ({ ...prev, post: { ...prev.post, performersText: e.target.value } })),
                          placeholder: "e.g. Crystal Rush, Sarah Vandella",
                        })
                      ),
                      React.createElement(
                        Form.Group,
                        null,
                        React.createElement(Form.Label, null, "Studio"),
                        React.createElement(Form.Control, {
                          type: "text", size: "sm",
                          value: (previewState.post && previewState.post.studioText) || "",
                          onChange: (e) => setPreviewState(prev => ({ ...prev, post: { ...prev.post, studioText: e.target.value } })),
                          placeholder: "e.g. MommyBlowsBest",
                        })
                      )
                    ),
                    React.createElement(
                      "div",
                      { className: "small text-muted mb-2" },
                      "Names that don't exist will be auto-created. Tags/performers/studio apply to imported scenes AND images via bulk-update after the scan completes."
                    ),
                    React.createElement(
                      "div",
                      { className: "d-flex flex-column gap-2 mt-2" },
                      React.createElement(Form.Check, {
                        type: "switch", id: "mega-preview-make-gallery",
                        label: "Create a gallery from imported images",
                        checked: !!(previewState.post && previewState.post.makeGallery),
                        onChange: (e) => setPreviewState(prev => ({ ...prev, post: { ...prev.post, makeGallery: e.target.checked } })),
                      }),
                      React.createElement(Form.Check, {
                        type: "switch", id: "mega-preview-rename-from-folder",
                        label: "Rename files from folder name (e.g. MainFolder_SubFolder_001.mp4)",
                        checked: !!(previewState.post && previewState.post.renameFromFolder),
                        onChange: (e) => setPreviewState(prev => ({ ...prev, post: { ...prev.post, renameFromFolder: e.target.checked } })),
                      }),
                      previewState.post && previewState.post.renameFromFolder && React.createElement(
                        "div",
                        { className: "small text-muted ml-4" },
                        "Pattern: ",
                        React.createElement("code", null, "<mainFolder>_<subFolder>_<NUM>.<ext>"),
                        " — original MEGA filenames are discarded. NUM is per-subfolder, zero-padded to 3 digits."
                      )
                    ),
                    previewState.post && previewState.post.makeGallery && React.createElement(
                      Form.Group,
                      { className: "mt-2" },
                      React.createElement(Form.Label, { className: "small" }, "Gallery title"),
                      React.createElement(Form.Control, {
                        type: "text", size: "sm",
                        value: (previewState.post && previewState.post.galleryTitle) || "",
                        onChange: (e) => setPreviewState(prev => ({ ...prev, post: { ...prev.post, galleryTitle: e.target.value } })),
                      })
                    ),

                    // Per-extension toggle row
                    React.createElement("h6", { className: "mt-3 mega-settings-group" }, "By extension"),
                    React.createElement(
                      "div",
                      { className: "mega-preview-ext-grid" },
                      Object.entries(m.by_ext)
                        .sort((a, b) => b[1].count - a[1].count)
                        .map(([ext, info]) => {
                          const isExcluded = excludeExts.has(ext);
                          return React.createElement(
                            "label",
                            {
                              key: ext,
                              className: "mega-preview-ext-pill" + (isExcluded ? " excluded" : ""),
                              title: `${info.count} file(s), ${humanSize(info.bytes)}`,
                            },
                            React.createElement("input", {
                              type: "checkbox",
                              checked: !isExcluded,
                              onChange: () => setPreviewState(prev => {
                                const next = new Set(prev.excludeExts);
                                if (isExcluded) next.delete(ext); else next.add(ext);
                                return { ...prev, excludeExts: next };
                              }),
                            }),
                            React.createElement("span", { className: "ext-name" }, "." + (ext || "(no ext)")),
                            React.createElement("span", { className: "ext-count" }, ` ${info.count}`),
                            React.createElement("span", { className: "ext-bytes" }, ` (${humanSize(info.bytes)})`)
                          );
                        })
                    ),
                    // Per-file list with checkboxes (capped to ~200 to avoid jank)
                    React.createElement("h6", { className: "mt-3 mega-settings-group" },
                      `Files (showing first ${Math.min(200, m.files.length)} of ${m.files.length})`),
                    React.createElement(
                      "div",
                      { className: "mega-preview-file-list" },
                      m.files.slice(0, 200).map((f, idx) => {
                        const isExcluded = excluded.has(f.path) || excludeExts.has(f.ext);
                        return React.createElement(
                          "label",
                          { key: idx, className: "mega-preview-file-row" + (isExcluded ? " excluded" : "") },
                          React.createElement("input", {
                            type: "checkbox",
                            checked: !isExcluded,
                            disabled: excludeExts.has(f.ext),
                            onChange: () => setPreviewState(prev => {
                              const next = new Set(prev.excluded);
                              if (next.has(f.path)) next.delete(f.path); else next.add(f.path);
                              return { ...prev, excluded: next };
                            }),
                          }),
                          React.createElement("span", { className: "preview-file-path", title: f.path }, f.path),
                          React.createElement("span", { className: "preview-file-size" }, humanSize(f.size))
                        );
                      })
                    )
                  );
                })()
          ),
          React.createElement(
            Modal.Footer,
            null,
            React.createElement(Button, { variant: "secondary", onClick: () => setPreviewState(null) }, "Cancel"),
            React.createElement(
              Button,
              {
                variant: "primary",
                onClick: confirmPreviewImport,
                disabled: previewState.loading || !previewState.manifest || previewState.manifest.files.length === 0,
              },
              previewState.loading ? "Loading…" : "Confirm import"
            )
          )
        )
      )
    );
  };

  // Stash registerRoute signature is positional: (path, component) — not an
  // object. Passing an object silently no-ops; the route never matches and
  // the component never mounts.
  api.register.route("/mega-browser", MegaBrowserPage);

  api.patch.before("MainNavBar.UtilityItems", function (props) {
    return [
      {
        children: React.createElement(
          React.Fragment,
          null,
          props.children,
          React.createElement(NavbarPlugin, null)
        ),
      },
    ];
  });

  console.log(`${LOG_PREFIX} plugin loaded`);
})();
