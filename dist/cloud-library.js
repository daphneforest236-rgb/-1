(() => {
  const cloudApiBase = window.KTV_WEB_API_URL || (location.protocol === 'file:' ? 'http://127.0.0.1:8787' : '');
  const PLAYLIST_PAGE_LIMIT = 30;
  const cloudState = {
    user: null,
    active: false,
    loading: false,
    localCandidates: [],
    neteasePlaylistInputs: [],
    neteaseBatchPreview: null,
    neteaseAccount: { status: 'unknown', nickname: null, error: null },
    myNeteasePlaylists: { items: [], offset: 0, more: null, loading: false, error: null }
  };
  const initialLocalLibrary = Array.isArray(state.library) ? state.library.map(track => ({ ...track })) : [];
  cloudState.localCandidates = initialLocalLibrary.length ? initialLocalLibrary : (window.KTV_IMPORTED?.tracks || []).map(track => ({ ...track }));

  const cloudRequest = async (path, options = {}) => {
    let response;
    try {
      response = await fetch(cloudApiBase + path, {
        ...options,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
      });
    } catch {
      throw new Error('无法连接云端 API。');
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `云端请求失败（${response.status}）。`);
    return payload;
  };

  const cloudStatus = () => document.querySelector('#cloudLibraryStatus');
  const showCloudStatus = (message, level = '') => {
    const element = cloudStatus();
    if (!element) return;
    element.className = `cloud-library-status ${level}`;
    element.textContent = message;
  };
  const injectCloudStatus = () => {
    if (cloudStatus()) return;
    document.querySelector('.app').insertAdjacentHTML('afterbegin', '<div id="cloudLibraryStatus" class="cloud-library-status" aria-live="polite">正在确认网站登录和云端曲库…</div>');
  };
  const normalTrack = track => ({
    id: track.id,
    sourceSongId: track.sourceSongId,
    title: track.title,
    artist: track.artist,
    lang: track.lang || '中文',
    cover: track.cover || 'a',
    recent: Number(track.recent) || 0,
    total: Number(track.total) || 0,
    pref: track.pref || '正常',
    black: Boolean(track.black),
    manual: Boolean(track.manual),
    source: track.source || 'manual'
  });
  const resetSongSession = () => {
    state.session = es();
    state.languages = [...new Set(['中文', '日文', '英文', ...state.library.map(track => track.lang)])];
    state.languages.forEach(language => {
      state.session.shown[language] ??= [];
      state.session.current[language] ??= [];
    });
  };

  async function loadCloudLibrary() {
    if (!cloudState.user) return;
    cloudState.loading = true;
    showCloudStatus(`正在读取 ${cloudState.user.displayName} 的云端曲库…`);
    try {
      const result = await cloudRequest('/library/tracks');
      state.library = result.tracks.map(normalTrack);
      resetSongSession();
      cloudState.active = true;
      ensure();
      showCloudStatus(`云端曲库：已读取 ${state.library.length} 首。当前网站账号：${cloudState.user.displayName}。`, 'ready');
    } catch (error) {
      cloudState.active = false;
      state.library = [];
      resetSongSession();
      render();
      showCloudStatus(`云端曲库读取失败：${error.message}。未显示本机或演示歌曲。`, 'error');
    } finally {
      cloudState.loading = false;
    }
  }

  async function identifyCloudUser() {
    injectCloudStatus();
    if (location.protocol === 'file:') {
      showCloudStatus('本机兼容模式：当前通过 file:// 打开，歌曲来自本机数据，不是云端曲库。', 'local');
      return;
    }
    try {
      const result = await cloudRequest('/me');
      cloudState.user = result.user;
      await loadCloudLibrary();
    } catch (error) {
      if (error.message === '请先登录网站账号。') {
        cloudState.user = null;
        cloudState.active = false;
        state.library = [];
        resetSongSession();
        render();
        showCloudStatus('未登录：主页面不会显示云端曲库，也不会回退到本机或演示歌曲。请登录网站账号。', 'local');
        return;
      }
      cloudState.user = null;
      cloudState.active = false;
      showCloudStatus(`云端身份检查失败：${error.message}`, 'error');
    }
  }

  const phaseOneRefresh = window.webAccountRefresh;
  window.webAccountRefresh = async () => {
    await phaseOneRefresh();
    await identifyCloudUser();
  };

  const phaseOneSettings = window.settings;
  window.settings = () => {
    phaseOneSettings();
    const playlistEntry = document.createElement('button');
    playlistEntry.className = 'row';
    playlistEntry.innerHTML = '我的网易云歌单 <span>›</span>';
    playlistEntry.onclick = openMyNeteasePlaylists;
    const entry = document.createElement('button');
    entry.className = 'row';
    entry.innerHTML = '云端曲库 <span>›</span>';
    entry.onclick = openCloudLibrary;
    const danger = document.querySelector('#sheet .danger');
    document.querySelector('#sheet').insertBefore(playlistEntry, danger || null);
    document.querySelector('#sheet').insertBefore(entry, danger || null);
  };

  const safePlaylist = item => {
    const sourceId = String(item?.sourceId ?? '').trim();
    const name = typeof item?.name === 'string' ? item.name.trim() : '';
    const trackCount = Number(item?.trackCount);
    if (!sourceId || !name || !Number.isSafeInteger(trackCount) || trackCount < 0) return null;
    const coverUrl = typeof item?.coverUrl === 'string' && item.coverUrl.trim() ? item.coverUrl.trim() : null;
    return { sourceId, name, trackCount, coverUrl };
  };

  const renderMyNeteasePlaylistCards = () => {
    const playlistState = cloudState.myNeteasePlaylists;
    if (playlistState.loading && !playlistState.items.length) return '<div class="note">正在读取我的网易云歌单…</div>';
    if (playlistState.error) return `<div class="note netease-account-error">${h(playlistState.error)}</div><button class="secondary" onclick="retryMyNeteasePlaylists()">重试</button>`;
    if (!playlistState.items.length) return '<div class="pending-empty">暂无歌单。</div>';
    const cards = playlistState.items.map(playlist => {
      const cover = playlist.coverUrl
        ? `<img src="${h(playlist.coverUrl)}" alt="" loading="lazy">`
        : '<span>歌单</span>';
      return `<article class="netease-playlist-card" data-source-id="${h(playlist.sourceId)}"><div class="netease-playlist-cover">${cover}</div><div><strong>${h(playlist.name)}</strong><small>${playlist.trackCount} 首</small></div></article>`;
    }).join('');
    const loadMore = playlistState.loading
      ? '<div class="note">正在加载更多歌单…</div>'
      : playlistState.more === true
        ? '<button class="secondary" onclick="loadMoreMyNeteasePlaylists()">加载更多</button>'
        : '';
    return `<div class="netease-playlist-list">${cards}</div>${loadMore}`;
  };

  const renderMyNeteasePlaylists = () => {
    const account = cloudState.neteaseAccount;
    let body = '';
    if (account.status === 'unknown') body = '<div class="note">正在读取网易云连接状态…</div>';
    else if (account.status === 'unauthenticated') body = '<div class="note">请先登录网站账号，然后再查看网易云歌单。</div>';
    else if (account.status === 'disconnected') body = '<div class="note">需要先连接网易云账号。</div>';
    else if (account.status === 'reconnect_required') body = '<div class="note">网易云账号需要重新连接。</div>';
    else if (account.status === 'error') body = `<div class="note netease-account-error">${h(account.error || '网易云连接状态暂时不可用。')}</div><button class="secondary" onclick="retryMyNeteasePlaylists()">重试</button>`;
    else if (account.status === 'connected') {
      const nickname = account.nickname ? ` · ${h(account.nickname)}` : '';
      body = `<div class="note netease-account-ready">已连接网易云${nickname}</div><div class="sync-section">我的网易云歌单</div>${renderMyNeteasePlaylistCards()}`;
    }
    sheet(`<div class="handle"></div><h2>我的网易云歌单</h2>${body}<button class="secondary" onclick="settings()">返回设置</button>`);
  };

  async function readMyNeteaseConnection() {
    const result = await cloudRequest('/api/netease/account/status');
    const status = ['disconnected', 'connected', 'reconnect_required'].includes(result?.status) ? result.status : 'error';
    cloudState.neteaseAccount = {
      status,
      nickname: status === 'connected' && typeof result?.account?.nickname === 'string' ? result.account.nickname : null,
      error: status === 'error' ? '网易云连接状态暂时不可用。' : null
    };
    return status;
  }

  async function requestMyNeteasePlaylists({ append = false } = {}) {
    const playlistState = cloudState.myNeteasePlaylists;
    if (playlistState.loading) return;
    const offset = append ? playlistState.offset : 0;
    playlistState.loading = true;
    playlistState.error = null;
    renderMyNeteasePlaylists();
    try {
      const result = await cloudRequest(`/api/netease/account/playlists?limit=${PLAYLIST_PAGE_LIMIT}&offset=${offset}`);
      const existingIds = append ? new Set(playlistState.items.map(item => item.sourceId)) : new Set();
      const incoming = Array.isArray(result?.items) ? result.items.map(safePlaylist).filter(Boolean).filter(item => {
        if (existingIds.has(item.sourceId)) return false;
        existingIds.add(item.sourceId);
        return true;
      }) : [];
      playlistState.items = append ? [...playlistState.items, ...incoming] : incoming;
      playlistState.offset = offset + PLAYLIST_PAGE_LIMIT;
      playlistState.more = typeof result?.more === 'boolean' ? result.more : null;
    } catch (error) {
      if (error.message === '请先登录网站账号。') cloudState.neteaseAccount = { status: 'unauthenticated', nickname: null, error: null };
      else playlistState.error = '网易云歌单暂时无法读取，请稍后重试。';
    } finally {
      playlistState.loading = false;
      renderMyNeteasePlaylists();
    }
  }

  async function openMyNeteasePlaylists() {
    cloudState.myNeteasePlaylists = { items: [], offset: 0, more: null, loading: false, error: null };
    cloudState.neteaseAccount = { status: 'unknown', nickname: null, error: null };
    renderMyNeteasePlaylists();
    try {
      const status = await readMyNeteaseConnection();
      renderMyNeteasePlaylists();
      if (status === 'connected') await requestMyNeteasePlaylists();
    } catch (error) {
      cloudState.neteaseAccount = error.message === '请先登录网站账号。'
        ? { status: 'unauthenticated', nickname: null, error: null }
        : { status: 'error', nickname: null, error: '网易云连接状态暂时不可用。' };
      renderMyNeteasePlaylists();
    }
  }

  window.loadMoreMyNeteasePlaylists = () => requestMyNeteasePlaylists({ append: true });
  window.retryMyNeteasePlaylists = () => openMyNeteasePlaylists();

  const renderLibraryRows = () => state.library.length
    ? state.library.map(track => `<div class="list-item"><span><strong>${h(track.title)}</strong><br><small>${h(track.artist)} · ${h(track.lang)} · ${h(track.pref)}</small></span><button class="source-remove" onclick="deleteCloudTrack('${track.id}')">删除</button></div>`).join('')
    : '<div class="pending-empty">你的云端曲库目前没有歌曲。</div>';
  const renderNeteasePreview = () => {
    const preview = cloudState.neteaseBatchPreview;
    if (!preview) return '';
    const playlistRows = preview.playlists.map(playlist => {
      if (playlist.error) return `<li><strong>${h(playlist.sourceId || '无效输入')}</strong> · 读取失败：${h(playlist.error.message)}</li>`;
      return `<li><strong>${h(playlist.name)}</strong> · ${playlist.trackCount} 首（返回 ${playlist.returnedTrackCount} 首）· ${playlist.complete ? '完整' : '不完整'}</li>`;
    }).join('');
    const confirm = preview.complete
      ? '<button class="primary" onclick="confirmNeteasePlaylistImport()">确认全部导入到我的云端曲库</button>'
      : '<div class="note">存在读取失败或不完整歌单，请删除问题歌单后重新预览。</div>';
    const duplicateInputs = preview.duplicatePlaylistInputCount ? `<br>重复输入已合并：${preview.duplicatePlaylistInputCount} 个` : '';
    return `<div class="sync-section">批量歌单预览</div><div class="note">选择 ${preview.playlistCount} 个歌单<br>原始共 ${preview.rawTrackCount} 首 · 跨歌单重复 ${preview.crossPlaylistDuplicateCount} 首<br>去重后 ${preview.uniqueTrackCount} 首 · 云端已有 ${preview.existingCount} 首 · 本次预计新增 ${preview.newCount} 首${duplicateInputs}<br>${preview.complete ? '全部歌单完整，可确认导入。' : '存在问题歌单，已禁止导入。'}</div><ul class="netease-preview-list">${playlistRows}</ul>${confirm}`;
  };
  const renderNeteasePlaylistInputs = () => cloudState.neteasePlaylistInputs.length
    ? `<ul class="netease-preview-list">${cloudState.neteasePlaylistInputs.map((playlist, index) => `<li>${h(playlist)} <button class="source-remove" onclick="removeNeteasePlaylist(${index})">删除</button></li>`).join('')}</ul>`
    : '<div class="note">尚未添加歌单；一次最多 10 个。</div>';
  function openCloudLibrary() {
    if (!cloudState.user) {
      sheet('<div class="handle"></div><h2>云端曲库</h2><div class="note">请先在“网站账号与云端测试”中登录网站账号。</div><button class="secondary" onclick="settings()">返回设置</button>');
      return;
    }
    const importNote = cloudState.localCandidates.length
      ? `<button class="secondary" onclick="importLocalLibrary()">将本机候选歌曲导入当前账号（${cloudState.localCandidates.length} 首）</button>`
      : '';
    sheet(`<div class="handle"></div><h2>云端曲库</h2><p>当前网站账号：${h(cloudState.user.displayName)}。这些歌曲来自 PostgreSQL，不会与其他账号混合。</p><div class="note" id="cloudLibraryPanelStatus">当前云端曲库：${state.library.length} 首。</div><div class="sync-section">批量导入公开网易云歌单</div><input id="neteasePlaylistCandidate" maxlength="500" placeholder="输入网易云歌单 ID 或 music.163.com 链接"><button class="secondary" onclick="addNeteasePlaylist()">添加歌单</button>${renderNeteasePlaylistInputs()}<button class="secondary" onclick="previewNeteasePlaylists()">批量预览</button>${renderNeteasePreview()}${importNote}<input id="cloudTrackTitle" maxlength="200" placeholder="歌名"><input id="cloudTrackArtist" maxlength="200" placeholder="歌手"><input id="cloudTrackLang" maxlength="40" value="中文" placeholder="语言"><button class="primary" onclick="addCloudTrack()">添加到我的云端曲库</button><div class="sync-section">当前歌曲</div>${renderLibraryRows()}<button class="secondary" onclick="settings()">返回设置</button>`);
  }
  const panelStatus = text => { const element = document.querySelector('#cloudLibraryPanelStatus'); if (element) element.textContent = text; };
  window.addCloudTrack = async () => {
    const title = document.querySelector('#cloudTrackTitle')?.value.trim();
    const artist = document.querySelector('#cloudTrackArtist')?.value.trim();
    const lang = document.querySelector('#cloudTrackLang')?.value.trim() || '中文';
    if (!title || !artist) return toast('请填写歌名和歌手');
    panelStatus('正在保存到云端…');
    try {
      await cloudRequest('/library/tracks', { method: 'POST', body: JSON.stringify({ title, artist, lang, source: 'manual' }) });
      await loadCloudLibrary();
      openCloudLibrary();
      toast('已添加到你的云端曲库');
    } catch (error) { panelStatus(`保存失败：${error.message}`); toast(error.message); }
  };
  window.deleteCloudTrack = async id => {
    if (!window.confirm('从当前网站账号的云端曲库删除这首歌？')) return;
    panelStatus('正在删除…');
    try {
      await cloudRequest(`/library/tracks/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await loadCloudLibrary();
      openCloudLibrary();
      toast('已从你的云端曲库删除');
    } catch (error) { panelStatus(`删除失败：${error.message}`); toast(error.message); }
  };
  window.importLocalLibrary = async () => {
    if (!cloudState.localCandidates.length) return;
    if (!window.confirm(`将 ${cloudState.localCandidates.length} 首本机候选歌曲导入当前网站账号？此操作不会删除本机数据。`)) return;
    panelStatus('正在导入到云端…');
    try {
      const result = await cloudRequest('/library/import', { method: 'POST', body: JSON.stringify({ tracks: cloudState.localCandidates }) });
      await loadCloudLibrary();
      openCloudLibrary();
      toast(`已导入 ${result.added} 首；已跳过 ${result.skipped} 首重复歌曲`);
    } catch (error) { panelStatus(`导入失败：${error.message}`); toast(error.message); }
  };
  window.addNeteasePlaylist = () => {
    const input = document.querySelector('#neteasePlaylistCandidate')?.value.trim() || '';
    if (!input) return toast('请输入网易云公开歌单 ID 或链接');
    if (cloudState.neteasePlaylistInputs.length >= 10) return toast('一次最多添加 10 个歌单');
    cloudState.neteasePlaylistInputs.push(input);
    cloudState.neteaseBatchPreview = null;
    openCloudLibrary();
  };
  window.removeNeteasePlaylist = index => {
    cloudState.neteasePlaylistInputs.splice(index, 1);
    cloudState.neteaseBatchPreview = null;
    openCloudLibrary();
  };
  window.previewNeteasePlaylists = async () => {
    if (!cloudState.neteasePlaylistInputs.length) return toast('请先添加至少一个公开歌单');
    cloudState.neteaseBatchPreview = null;
    panelStatus('正在读取公开网易云歌单…');
    try {
      cloudState.neteaseBatchPreview = await cloudRequest('/api/netease/import/batch/preview', { method: 'POST', body: JSON.stringify({ playlists: cloudState.neteasePlaylistInputs }) });
      openCloudLibrary();
      panelStatus('歌单预览已生成。请核对数量后确认导入。');
    } catch (error) {
      panelStatus(`歌单预览失败：${error.message}`);
      toast(error.message);
    }
  };
  window.confirmNeteasePlaylistImport = async () => {
    if (!cloudState.neteaseBatchPreview || !cloudState.neteaseBatchPreview.complete) return;
    if (!window.confirm(`确认将 ${cloudState.neteaseBatchPreview.newCount} 首新歌曲导入当前网站账号？`)) return;
    panelStatus('正在导入公开网易云歌单…');
    try {
      const result = await cloudRequest('/api/netease/import/batch', { method: 'POST', body: JSON.stringify({ playlists: cloudState.neteasePlaylistInputs }) });
      cloudState.neteaseBatchPreview = null;
      cloudState.neteasePlaylistInputs = [];
      await loadCloudLibrary();
      openCloudLibrary();
      toast(`已导入 ${result.imported} 首；已跳过 ${result.skipped} 首重复歌曲`);
    } catch (error) {
      panelStatus(`歌单导入失败：${error.message}`);
      toast(error.message);
    }
  };

  const basePref = window.pref;
  window.pref = async (id, pref) => {
    if (!cloudState.active) return basePref(id, pref);
    const track = get(id); if (!track) return;
    const previous = track.pref; track.pref = pref; render();
    try { await cloudRequest(`/library/tracks/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ pref }) }); toast('推荐等级已保存到云端'); }
    catch (error) { track.pref = previous; render(); toast(`云端保存失败：${error.message}`); }
  };
  const baseBlack = window.black;
  window.black = async id => {
    if (!cloudState.active) return baseBlack(id);
    const track = get(id); if (!track) return;
    const previous = track.black; track.black = true; state.session.current[track.lang] = state.session.current[track.lang].filter(value => value !== id); closeSheet(); render();
    try { await cloudRequest(`/library/tracks/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ black: true }) }); toast('黑名单已保存到云端'); }
    catch (error) { track.black = previous; render(); toast(`云端保存失败：${error.message}`); }
  };
  const baseMove = window.move;
  window.move = async (id, language) => {
    if (!cloudState.active) return baseMove(id, language);
    const track = get(id); if (!track || track.lang === language) return closeSheet();
    const previousLanguage = track.lang; const previousManual = track.manual;
    state.session.current[track.lang] = state.session.current[track.lang].filter(value => value !== id); track.lang = language; track.manual = true; closeSheet(); render();
    try { await cloudRequest(`/library/tracks/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ lang: language, manual: true }) }); toast('语言分类已保存到云端'); }
    catch (error) { track.lang = previousLanguage; track.manual = previousManual; render(); toast(`云端保存失败：${error.message}`); }
  };
  const baseClearAll = window.clearAll;
  window.clearAll = () => {
    if (!cloudState.active) return baseClearAll();
    closeSheet();
    toast('当前登录的是云端曲库；本地清除不会删除或替换云端歌曲。');
    loadCloudLibrary();
  };

  document.head.insertAdjacentHTML('beforeend', '<style>.cloud-library-status{margin:0 0 14px;padding:10px 12px;border-radius:10px;background:#2a292e;color:#b2aeb3;font-size:13px;line-height:1.55}.cloud-library-status.ready,.netease-account-ready{color:#a8dfb7;border-left:3px solid #49b36d}.cloud-library-status.error,.netease-account-error{color:#ffb0b8;border-left:3px solid #ef4051}.cloud-library-status.local{color:#d7cba6;border-left:3px solid #c6a65c}#sheet input{width:100%;margin:0 0 9px;padding:13px;border:1px solid #4a474d;border-radius:10px;background:#1b1b20;color:#fff;font:inherit}#sheet small{color:#aaa6ab}.netease-preview-list{margin:8px 0 12px;padding-left:20px;color:#cfcbd0;font-size:13px;line-height:1.6}.netease-playlist-list{margin:8px 0 12px}.netease-playlist-card{display:grid;grid-template-columns:52px minmax(0,1fr);gap:12px;align-items:center;padding:11px 0;border-top:1px solid #302f34}.netease-playlist-cover{width:52px;height:52px;border-radius:9px;overflow:hidden;display:grid;place-items:center;background:linear-gradient(140deg,#3a2944,#263b55);color:#d7cba6;font-size:11px;font-weight:800}.netease-playlist-cover img{width:100%;height:100%;object-fit:cover}.netease-playlist-card strong{display:block;line-height:1.4;word-break:break-word}.netease-playlist-card small{display:block;margin-top:4px}</style>');
  setTimeout(identifyCloudUser, 0);
})();
