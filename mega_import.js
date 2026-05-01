"use strict";
(function() {
  const api = window.PluginApi;
  const React = api.React;
  const { Button, Modal, Form, Alert, Collapse, InputGroup } = api.libraries.Bootstrap;
  const { faCloudDownloadAlt, faSpinner, faSignInAlt, faFolder, faFile, faHome, faSignOutAlt, faCog, faCheckSquare, faSquare, faFilter, faSearch, faTimes, faHistory, faCheck } = api.libraries.FontAwesomeSolid;
  const { Icon } = api.components;
  const { gql, useApolloClient } = api.libraries.Apollo;

  const LOG_PREFIX = "[mega-import]";
  const OPEN_LOGIN_EVENT = "mega-import:open-login";
  const PLUGIN_ID = "mega_import";
  const TASK_NAME = "MEGA Operation";
  const SESSION_STORAGE_KEY = "mega-import:session";
  const SETTINGS_STORAGE_KEY = "mega-import:settings";
  const HISTORY_STORAGE_KEY = "mega-import:history";
  const HISTORY_MAX_ENTRIES = 500;
  const DEFAULT_SETTINGS = { dest: "", filter: "all", customExts: "", concurrency: 3 };
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

  // Bridge constants
  const RUN_TASK = gql`
    mutation MegaImport_RunTask($id: ID!, $name: String!, $args: Map) {
      runPluginTask(plugin_id: $id, task_name: $name, args_map: $args)
    }
  `;
  const FIND_JOB = gql`
    query MegaImport_FindJob($id: ID!) {
      findJob(input: { id: $id }) { id status error description }
    }
  `;
  const METADATA_SCAN = gql`
    mutation MegaImport_Scan($input: ScanMetadataInput!) {
      metadataScan(input: $input)
    }
  `;
  const POLL_INTERVAL_MS = 250;
  const POLL_TIMEOUT_MS = 5 * 60 * 1000;

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

    // Run a backend action via Stash's plugin task system. Polls the job until
    // it finishes, then decodes the OK:/ERR: prefix Python wrote into Job.error.
    async _runTask(action, args) {
      // ApolloCapture sets _client in a useEffect; on a direct reload to
      // /mega-browser, the browser page can mount before that fires. Give it
      // a brief grace period.
      const waitDeadline = Date.now() + 3000;
      while (!this._client && Date.now() < waitDeadline) {
        await new Promise(r => setTimeout(r, 50));
      }
      if (!this._client) {
        throw new Error("Apollo client not initialized — plugin not fully loaded");
      }
      const argsMap = Object.assign({ action }, args || {});
      let jobId;
      try {
        const startResp = await this._client.mutate({
          mutation: RUN_TASK,
          variables: { id: PLUGIN_ID, name: TASK_NAME, args: argsMap },
        });
        jobId = startResp && startResp.data && startResp.data.runPluginTask;
      } catch (e) {
        logError("runPluginTask", e, { action });
        throw new Error("Failed to start MEGA task: " + (e.message || e));
      }
      if (!jobId) throw new Error("runPluginTask returned no job id");

      const deadline = Date.now() + POLL_TIMEOUT_MS;
      // Poll. (Subscriptions would be cleaner but polling is simpler and fine
      // for the latencies we care about; first poll happens after one interval.)
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        let job;
        try {
          const r = await this._client.query({
            query: FIND_JOB,
            variables: { id: jobId },
            fetchPolicy: "no-cache",
          });
          job = r && r.data && r.data.findJob;
        } catch (e) {
          logError("findJob", e, { jobId, action });
          throw new Error("Failed to read job status: " + (e.message || e));
        }
        if (!job) {
          // Stash drops jobs from its queue once they finish — if we missed the
          // window, treat as completion-without-result. Surface as a clear error.
          throw new Error("Job " + jobId + " disappeared before result was read");
        }
        if (job.status === "FINISHED" || job.status === "FAILED" || job.status === "CANCELLED") {
          return decodeJobResult(job, action);
        }
      }
      throw new Error("MEGA task '" + action + "' timed out");
    },

    async login(email, password, rememberMe) {
      const result = await this._runTask("login", { email, password });
      this._session = {
        email: result.email,
        rememberMe: !!rememberMe,
      };
      this._emitSessionChange();
      return this._session;
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
    async downloadFiles(paths, destOverride, onProgress, signal, concurrency) {
      const total = paths.length;
      const conc = Math.max(1, Math.min(concurrency || 1, MAX_CONCURRENCY));
      const allItems = [];
      let resolvedDest = null;
      let nextIndex = 0;
      let completed = 0;
      let inFlight = 0;

      const downloadOne = async (filePath) => {
        const taskArgs = { paths: [filePath] };
        if (destOverride) taskArgs.dest = destOverride;
        try {
          const resp = await this._runTask("download", taskArgs);
          if (resp.dest && !resolvedDest) resolvedDest = resp.dest;
          return (resp.items && resp.items[0]) || { path: filePath, status: "error", error: "no result" };
        } catch (e) {
          return { path: filePath, status: "error", error: e.message || String(e) };
        }
      };

      const worker = async () => {
        while (true) {
          if (signal && signal.aborted) return;
          const myIndex = nextIndex++;
          if (myIndex >= total) return;
          const filePath = paths[myIndex];
          inFlight++;
          if (onProgress) onProgress({ completed, total, inFlight, current: filePath, lastResult: null });

          const itemResult = await downloadOne(filePath);
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

      return {
        imported: ok.length,
        dest: resolvedDest,
        scanError,
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

  // Decode Python's OK:<json> / ERR:<msg> envelope from Job.error.
  const decodeJobResult = (job, action) => {
    const err = job.error || "";
    if (err.startsWith("OK:")) {
      try { return JSON.parse(err.slice(3)); }
      catch (e) {
        logError("decode OK", e, { action, error_preview: err.slice(0, 200) });
        throw new Error("Backend returned malformed OK payload");
      }
    }
    if (err.startsWith("ERR:")) {
      throw new Error(err.slice(4));
    }
    if (job.status === "FAILED" || job.status === "CANCELLED") {
      throw new Error("MEGA task " + job.status.toLowerCase() + ": " + (err || "no detail"));
    }
    // Job finished but Job.error has neither prefix — Python likely crashed
    // before printing the envelope. Surface what we have.
    throw new Error("Backend returned unrecognized output: " + (err.slice(0, 200) || "(empty)"));
  };

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
        api.utils.navigate("/mega-browser");
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

  // LoginModal — login form only. No tabs.
  const LoginModal = ({ show, onClose, onLoggedIn }) => {
    const [email, setEmail] = React.useState("");
    const [password, setPassword] = React.useState("");
    const [rememberMe, setRememberMe] = React.useState(false);
    const [isLoading, setIsLoading] = React.useState(false);
    const [errorMsg, setErrorMsg] = React.useState(null);
    const toast = api.hooks.useToast();

    const reset = () => {
      setEmail("");
      setPassword("");
      setRememberMe(false);
      setErrorMsg(null);
    };

    const handleClose = () => {
      if (isLoading) return;
      reset();
      onClose();
    };

    const handleSubmit = async (e) => {
      if (e && e.preventDefault) e.preventDefault();
      if (!email || !password) {
        setErrorMsg("Please enter your email and password.");
        return;
      }
      setIsLoading(true);
      setErrorMsg(null);
      try {
        await MegaApiClient.login(email, password, rememberMe);
        toast.success("Logged in to MEGA");
        reset();
        onClose();
        onLoggedIn();
      } catch (error) {
        const msg = (error && error.message) || "Unknown error";
        setErrorMsg(`Login failed: ${msg}`);
        toast.error(`MEGA login failed: ${msg}`);
      } finally {
        setIsLoading(false);
      }
    };

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
        errorMsg && React.createElement(Alert, { variant: "danger" }, errorMsg),
        React.createElement(
          Form,
          { onSubmit: handleSubmit },
          React.createElement(
            Form.Group,
            { className: "mb-3" },
            React.createElement(Form.Label, null, "Email"),
            React.createElement(Form.Control, {
              type: "email",
              value: email,
              onChange: (e) => setEmail(e.target.value),
              placeholder: "your@email.com",
              disabled: isLoading,
              autoFocus: true,
            })
          ),
          React.createElement(
            Form.Group,
            { className: "mb-3" },
            React.createElement(Form.Label, null, "Password"),
            React.createElement(Form.Control, {
              type: "password",
              value: password,
              onChange: (e) => setPassword(e.target.value),
              placeholder: "Enter your MEGA password",
              disabled: isLoading,
            })
          ),
          React.createElement(
            Form.Group,
            { className: "mb-3" },
            React.createElement(Form.Check, {
              type: "checkbox",
              label: "Remember me",
              checked: rememberMe,
              onChange: (e) => setRememberMe(e.target.checked),
              disabled: isLoading,
            })
          ),
          // Hidden submit so Enter works in the form.
          React.createElement("button", { type: "submit", style: { display: "none" } })
        )
      ),
      React.createElement(
        Modal.Footer,
        null,
        React.createElement(
          Button,
          { variant: "secondary", onClick: handleClose, disabled: isLoading },
          "Cancel"
        ),
        React.createElement(
          Button,
          { variant: "primary", onClick: handleSubmit, disabled: isLoading },
          isLoading
            ? [React.createElement(Icon, { icon: faSpinner, spin: true, key: "i" }), " Signing in…"]
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
        onLoggedIn: () => api.utils.navigate("/mega-browser"),
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
    const abortRef = React.useRef(null);
    const importedSet = useImportedSet();
    const toast = api.hooks.useToast();

    // While searching, the results replace the file listing. currentPath is
    // preserved so "clear search" returns the user to where they were.
    const displayFiles = searchResults !== null ? searchResults : files;

    const visibleFiles = React.useMemo(
      () => displayFiles.filter(f => matchesFilter(f, settings.filter, settings.customExts)),
      [displayFiles, settings.filter, settings.customExts]
    );
    // Selectable = files OR folders (folders import recursively via mega-get).
    const visibleSelectablePaths = React.useMemo(
      () => visibleFiles.map(f => f.path),
      [visibleFiles]
    );

    // Redirect on unauthenticated visit (initial load OR logout-elsewhere).
    React.useEffect(() => {
      if (!session) {
        api.utils.navigate("/");
        requestLogin();
      }
    }, [session]);

    const loadPath = React.useCallback(async (path) => {
      setIsLoading(true);
      setErrorMsg(null);
      try {
        const list = await MegaApiClient.listFiles(path);
        setFiles(list);
        setCurrentPath(path);
        setSelectedItems([]);
      } catch (error) {
        const msg = (error && error.message) || "Unknown error";
        setErrorMsg(`Failed to load "${path}": ${msg}`);
        toast.error(`MEGA: ${msg}`);
      } finally {
        setIsLoading(false);
      }
    }, [toast]);

    React.useEffect(() => {
      if (session) loadPath("/");
    }, [session, loadPath]);

    const toggleItemSelection = (item) => {
      setSelectedItems(prev =>
        prev.includes(item.path) ? prev.filter(p => p !== item.path) : [...prev, item.path]
      );
    };

    const handleImport = async () => {
      if (selectedItems.length === 0) {
        toast.error("Select files to import first");
        return;
      }
      setIsLoading(true);
      setErrorMsg(null);
      setProgress({ completed: 0, total: selectedItems.length, current: null });
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const r = await MegaApiClient.downloadFiles(
          selectedItems,
          (settings.dest || "").trim() || null,
          (p) => setProgress(p),
          controller.signal,
          settings.concurrency
        );
        setResults(r);
        const failed = r.items.filter(i => !i.status.startsWith("Success")).length;
        if (r.cancelled) toast.warning(`Cancelled — ${r.imported} of ${selectedItems.length} imported`);
        else if (failed > 0) toast.warning(`${r.imported} imported, ${failed} failed`);
        else toast.success(`Imported ${r.imported} item(s) → ${r.dest || "default folder"}`);
        if (r.scanError) toast.warning(`Scan trigger failed: ${r.scanError}`);
      } catch (error) {
        const msg = (error && error.message) || "Unknown error";
        setErrorMsg(`Import failed: ${msg}`);
        toast.error(`MEGA import failed: ${msg}`);
      } finally {
        setIsLoading(false);
        setProgress(null);
        abortRef.current = null;
      }
    };

    const cancelImport = () => {
      if (abortRef.current) {
        abortRef.current.abort();
        toast.info("Cancelling after current file…");
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
        toast.success("Disconnected from MEGA");
        api.utils.navigate("/");
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
      // Effect above is redirecting; render nothing meaningful in the meantime.
      return React.createElement("div", { className: "mega-browser-page" });
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
            { variant: "secondary", onClick: () => api.utils.navigate("/"), className: "mr-2" },
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

      // Live progress bar during import
      progress && React.createElement(
        "div",
        { className: "mega-progress mb-3" },
        React.createElement(
          "div",
          { className: "mega-progress-label" },
          React.createElement(Icon, { icon: faSpinner, spin: true }),
          ` Importing ${progress.completed} / ${progress.total}`,
          progress.inFlight > 0 && React.createElement("span", { className: "mega-progress-inflight" }, ` (${progress.inFlight} in flight)`),
          progress.current && React.createElement("span", { className: "mega-progress-current" }, " — " + progress.current)
        ),
        React.createElement(
          "div",
          { className: "mega-progress-bar-outer" },
          React.createElement("div", {
            className: "mega-progress-bar-inner",
            style: { width: ((progress.completed / Math.max(progress.total, 1)) * 100) + "%" },
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
          React.createElement(
            Form.Group,
            { className: "mb-3" },
            React.createElement(Form.Label, null, "Import destination (server-side path)"),
            React.createElement(Form.Control, {
              type: "text",
              value: settings.dest,
              onChange: (e) => setSettings({ dest: e.target.value }),
              placeholder: "Leave blank to use plugin default (mega_imports/)",
            }),
            React.createElement(Form.Text, { className: "text-muted" },
              "Files are downloaded onto the machine running Stash, not your browser. Use a path Stash already scans for new media.")
          ),
          React.createElement(
            Form.Group,
            { className: "mb-2", style: { maxWidth: "260px" } },
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
              "Higher = faster on large selections; lower = gentler on bandwidth + the MEGAcmd daemon. Default 3.")
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

      React.createElement(
        "div",
        { className: "path-navigation mb-3" },
        React.createElement("strong", null, "Current path: "),
        React.createElement("span", null, currentPath)
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
            Button,
            { variant: "outline-secondary", size: "sm", onClick: selectAllVisible, disabled: visibleFilePaths.length === 0 },
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
          currentPath !== "/" && React.createElement(
            "div",
            { className: "file-item", onClick: goUp },
            React.createElement(Icon, { icon: faFolder }),
            React.createElement("span", { className: "file-name" }, "..")
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
            // Folders: clicking the row navigates IF we're in browse mode. In
            // search mode, clicking should select (no navigation, search shows
            // flat results from anywhere in the tree).
            const onRowClick = file.type === "folder" && searchResults === null
              ? () => loadPath(file.path)
              : () => toggleItemSelection(file);
            return React.createElement(
              "div",
              {
                key: file.id,
                className: `file-item ${isSelected ? "selected" : ""} ${wasImported ? "imported" : ""}`,
                onClick: onRowClick,
              },
              React.createElement(Icon, { icon: file.type === "folder" ? faFolder : faFile }),
              React.createElement("span", { className: "file-name" }, file.name,
                searchResults !== null && React.createElement("small", { className: "text-muted file-path-suffix" }, " — " + file.path)
              ),
              wasImported && React.createElement(
                "span",
                { className: "file-imported-badge", title: "Previously imported" },
                React.createElement(Icon, { icon: faCheck })
              ),
              file.type === "file" && file.size && React.createElement("span", { className: "file-size" }, file.size),
              React.createElement(Form.Check, {
                type: "checkbox",
                checked: isSelected,
                onChange: (e) => { e.stopPropagation(); toggleItemSelection(file); },
                onClick: (e) => e.stopPropagation(),
              })
            );
          })
        ),
        selectedItems.length > 0 && React.createElement(
          "div",
          { className: "selection-info mt-3" },
          React.createElement("span", null, `${selectedItems.length} item(s) selected`)
        ),
        results && React.createElement(
          "div",
          { className: "import-results mt-4" },
          React.createElement("h4", null, "Import Results"),
          React.createElement(
            "div",
            { className: "result-summary mb-2" },
            React.createElement("p", null, `Successfully imported ${results.imported} item(s).`)
          ),
          React.createElement(
            "div",
            { className: "result-details" },
            React.createElement("pre", null, JSON.stringify(results.items, null, 2))
          )
        )
      )
    );
  };

  api.register.route({
    path: "/mega-browser",
    component: MegaBrowserPage,
  });

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
