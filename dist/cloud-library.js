(() => {
  const cloudApiBase = window.KTV_WEB_API_URL || (location.protocol === 'file:' ? 'http://127.0.0.1:8787' : '');
  const cloudState = { user: null, active: false, loading: false, localCandidates: [] };
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
    const entry = document.createElement('button');
    entry.className = 'row';
    entry.innerHTML = '云端曲库 <span>›</span>';
    entry.onclick = openCloudLibrary;
    const danger = document.querySelector('#sheet .danger');
    document.querySelector('#sheet').insertBefore(entry, danger || null);
  };

  const renderLibraryRows = () => state.library.length
    ? state.library.map(track => `<div class="list-item"><span><strong>${h(track.title)}</strong><br><small>${h(track.artist)} · ${h(track.lang)} · ${h(track.pref)}</small></span><button class="source-remove" onclick="deleteCloudTrack('${track.id}')">删除</button></div>`).join('')
    : '<div class="pending-empty">你的云端曲库目前没有歌曲。</div>';
  function openCloudLibrary() {
    if (!cloudState.user) {
      sheet('<div class="handle"></div><h2>云端曲库</h2><div class="note">请先在“网站账号与云端测试”中登录网站账号。</div><button class="secondary" onclick="settings()">返回设置</button>');
      return;
    }
    const importNote = cloudState.localCandidates.length
      ? `<button class="secondary" onclick="importLocalLibrary()">将本机候选歌曲导入当前账号（${cloudState.localCandidates.length} 首）</button>`
      : '';
    sheet(`<div class="handle"></div><h2>云端曲库</h2><p>当前网站账号：${h(cloudState.user.displayName)}。这些歌曲来自 PostgreSQL，不会与其他账号混合。</p><div class="note" id="cloudLibraryPanelStatus">当前云端曲库：${state.library.length} 首。</div>${importNote}<input id="cloudTrackTitle" maxlength="200" placeholder="歌名"><input id="cloudTrackArtist" maxlength="200" placeholder="歌手"><input id="cloudTrackLang" maxlength="40" value="中文" placeholder="语言"><button class="primary" onclick="addCloudTrack()">添加到我的云端曲库</button><div class="sync-section">当前歌曲</div>${renderLibraryRows()}<button class="secondary" onclick="settings()">返回设置</button>`);
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

  document.head.insertAdjacentHTML('beforeend', '<style>.cloud-library-status{margin:0 0 14px;padding:10px 12px;border-radius:10px;background:#2a292e;color:#b2aeb3;font-size:13px;line-height:1.55}.cloud-library-status.ready{color:#a8dfb7;border-left:3px solid #49b36d}.cloud-library-status.error{color:#ffb0b8;border-left:3px solid #ef4051}.cloud-library-status.local{color:#d7cba6;border-left:3px solid #c6a65c}#sheet input{width:100%;margin:0 0 9px;padding:13px;border:1px solid #4a474d;border-radius:10px;background:#1b1b20;color:#fff;font:inherit}#sheet small{color:#aaa6ab}</style>');
  setTimeout(identifyCloudUser, 0);
})();
