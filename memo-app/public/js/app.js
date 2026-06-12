// ===== 메모장 앱 (서버 API 연동) =====

(function () {
  'use strict';

  // --- 상태 ---
  let notes = [];
  let notebooks = []; // [{id, name, note_count}]
  let tags = [];       // [{tag, count}]
  let currentFilter = 'all';
  let currentNoteId = null;
  let saveTimer = null;

  // --- DOM 요소 ---
  const dom = {
    btnNewNote: document.getElementById('btn-new-note'),
    btnNewNotebook: document.getElementById('btn-new-notebook'),
    notebookList: document.getElementById('notebook-list'),
    tagList: document.getElementById('tag-list'),
    noteList: document.getElementById('note-list'),
    panelTitle: document.getElementById('panel-title'),
    searchInput: document.getElementById('search-input'),
    sortSelect: document.getElementById('sort-select'),
    editorEmpty: document.getElementById('editor-empty'),
    editorContent: document.getElementById('editor-content'),
    editorTitle: document.getElementById('editor-title'),
    editorBody: document.getElementById('editor-body'),
    editorTags: document.getElementById('editor-tags'),
    tagInput: document.getElementById('tag-input'),
    editorDate: document.getElementById('editor-date'),
    editorNotebookName: document.getElementById('editor-notebook-name'),
    btnNoteNotebook: document.getElementById('btn-note-notebook'),
    btnToggleStar: document.getElementById('btn-toggle-star'),
    btnDeleteNote: document.getElementById('btn-delete-note'),
    btnRestoreNote: document.getElementById('btn-restore-note'),
    btnPermanentDelete: document.getElementById('btn-permanent-delete'),
    notebookDropdown: document.getElementById('notebook-dropdown'),
    countAll: document.getElementById('count-all'),
    countStarred: document.getElementById('count-starred'),
    countTrash: document.getElementById('count-trash'),
    navItems: document.querySelectorAll('.nav-item'),
    fmtBtns: document.querySelectorAll('.fmt-btn'),
  };

  // ===== API 호출 헬퍼 =====

  async function api(method, url, body) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (body !== undefined) {
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    if (!res.ok) {
      const err = await res.json().catch(function () { return { error: '요청 실패' }; });
      throw new Error(err.error || '서버 오류');
    }
    return res.json();
  }

  // ===== 유틸리티 =====

  function formatDate(dateStr) {
    const d = new Date(dateStr);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${year}.${month}.${day} ${hours}:${minutes}`;
  }

  function stripHtml(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    return tmp.textContent || tmp.innerText || '';
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(text));
    return div.innerHTML;
  }

  // ===== 데이터 로드 (서버에서) =====

  async function loadNotebooks() {
    notebooks = await api('GET', '/api/notebooks');
  }

  async function loadTags() {
    tags = await api('GET', '/api/tags');
  }

  async function loadNotes() {
    const params = new URLSearchParams();
    params.set('sort', dom.sortSelect.value);

    const search = dom.searchInput.value.trim();
    if (search) {
      params.set('search', search);
    }

    if (currentFilter === 'starred') {
      params.set('filter', 'starred');
    } else if (currentFilter === 'trash') {
      params.set('filter', 'trash');
    } else if (currentFilter.startsWith('notebook:')) {
      const nbName = currentFilter.replace('notebook:', '');
      const nb = notebooks.find(function (n) { return n.name === nbName; });
      if (nb) {
        params.set('notebook_id', nb.id);
      }
    } else if (currentFilter.startsWith('tag:')) {
      params.set('tag', currentFilter.replace('tag:', ''));
    }

    notes = await api('GET', '/api/notes?' + params.toString());
  }

  // ===== 노트 CRUD =====

  async function createNote() {
    let notebookId = null;

    if (currentFilter.startsWith('notebook:')) {
      const nbName = currentFilter.replace('notebook:', '');
      const nb = notebooks.find(function (n) { return n.name === nbName; });
      if (nb) {
        notebookId = nb.id;
      }
    }

    const note = await api('POST', '/api/notes', { notebook_id: notebookId });

    if (currentFilter === 'trash') {
      setFilter('all');
    }

    await refreshAll();
    selectNote(note.id);
    dom.editorTitle.focus();
  }

  async function deleteNote(noteId) {
    const note = findNote(noteId);
    if (!note) {
      return;
    }

    if (note.trashed) {
      await api('DELETE', '/api/notes/' + noteId);
    } else {
      await api('PUT', '/api/notes/' + noteId, { trashed: true });
    }

    if (currentNoteId === noteId) {
      currentNoteId = null;
      showEditor(false);
    }

    await refreshAll();
  }

  async function restoreNote(noteId) {
    await api('PUT', '/api/notes/' + noteId, { trashed: false });
    await refreshAll();
    selectNote(noteId);
  }

  function findNote(noteId) {
    return notes.find(function (n) { return n.id === noteId; });
  }

  // ===== 자동 저장 =====

  function scheduleSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(function () {
      saveCurrentNote();
    }, 500);
  }

  async function saveCurrentNote() {
    if (!currentNoteId) {
      return;
    }

    const note = findNote(currentNoteId);
    if (!note) {
      return;
    }

    const newTitle = dom.editorTitle.value;
    const newContent = dom.editorBody.innerHTML;

    if (note.title === newTitle && note.content === newContent) {
      return;
    }

    await api('PUT', '/api/notes/' + currentNoteId, {
      title: newTitle,
      content: newContent,
    });

    note.title = newTitle;
    note.content = newContent;
    note.updated_at = new Date().toISOString();

    renderNoteList();
  }

  // ===== 전체 새로고침 =====

  async function refreshAll() {
    await Promise.all([loadNotebooks(), loadTags(), loadNotes()]);
    await updateCountsFromServer();
    updateSidebarLists();
    renderNoteList();
  }

  // ===== 필터링 =====

  function setFilter(filter) {
    currentFilter = filter;

    dom.navItems.forEach(function (item) {
      item.classList.remove('active');
      if (item.dataset.filter === filter) {
        item.classList.add('active');
      }
    });

    document.querySelectorAll('.notebook-item, .tag-item').forEach(function (item) {
      item.classList.remove('active');
    });

    if (filter.startsWith('notebook:')) {
      const name = filter.replace('notebook:', '');
      document.querySelectorAll('.notebook-item').forEach(function (item) {
        if (item.dataset.name === name) {
          item.classList.add('active');
        }
      });
    } else if (filter.startsWith('tag:')) {
      const tag = filter.replace('tag:', '');
      document.querySelectorAll('.tag-item').forEach(function (item) {
        if (item.dataset.tag === tag) {
          item.classList.add('active');
        }
      });
    }

    const titles = {
      all: '모든 메모',
      starred: '중요 메모',
      trash: '휴지통',
    };

    if (titles[filter]) {
      dom.panelTitle.textContent = titles[filter];
    } else if (filter.startsWith('notebook:')) {
      dom.panelTitle.textContent = filter.replace('notebook:', '');
    } else if (filter.startsWith('tag:')) {
      dom.panelTitle.textContent = '#' + filter.replace('tag:', '');
    }

    loadNotes().then(renderNoteList);
  }

  // ===== 렌더링 =====

  function renderNoteList() {
    let html = '';

    notes.forEach(function (note) {
      const title = escapeHtml(note.title || '제목 없음');
      const preview = escapeHtml(stripHtml(note.content).substring(0, 100) || '내용 없음');
      const date = formatDate(note.updated_at);
      const isActive = note.id === currentNoteId ? ' active' : '';

      let tagsHtml = '';
      if (note.tags) {
        note.tags.forEach(function (tag) {
          tagsHtml += '<span class="note-card-tag">' + escapeHtml(tag) + '</span>';
        });
      }

      const starHtml = note.starred
        ? '<i class="fa-solid fa-star star-indicator"></i> '
        : '';

      html += '<div class="note-card' + isActive + '" data-id="' + note.id + '">'
        + '<div class="note-card-title">' + starHtml + title + '</div>'
        + '<div class="note-card-preview">' + preview + '</div>'
        + '<div class="note-card-footer">'
        + '<div class="note-card-tags">' + tagsHtml + '</div>'
        + '<span>' + date + '</span>'
        + '</div></div>';
    });

    if (notes.length === 0) {
      html = '<div style="text-align:center;padding:40px 16px;color:#999;">'
        + '<i class="fa-solid fa-inbox" style="font-size:32px;margin-bottom:12px;display:block;"></i>'
        + '메모가 없습니다</div>';
    }

    dom.noteList.innerHTML = html;

    dom.noteList.querySelectorAll('.note-card').forEach(function (card) {
      card.addEventListener('click', function () {
        selectNote(card.dataset.id);
      });
    });
  }

  function selectNote(noteId) {
    const note = findNote(noteId);
    if (!note) {
      return;
    }

    currentNoteId = noteId;
    showEditor(true);

    dom.editorTitle.value = note.title;
    dom.editorBody.innerHTML = note.content;
    dom.editorNotebookName.textContent = note.notebook_name || '기본 노트북';
    dom.editorDate.textContent = '수정: ' + formatDate(note.updated_at);

    updateStarButton(note.starred);

    if (note.trashed) {
      dom.btnDeleteNote.style.display = 'none';
      dom.btnToggleStar.style.display = 'none';
      dom.btnRestoreNote.style.display = '';
      dom.btnPermanentDelete.style.display = '';
      dom.editorBody.contentEditable = 'false';
      dom.editorTitle.readOnly = true;
    } else {
      dom.btnDeleteNote.style.display = '';
      dom.btnToggleStar.style.display = '';
      dom.btnRestoreNote.style.display = 'none';
      dom.btnPermanentDelete.style.display = 'none';
      dom.editorBody.contentEditable = 'true';
      dom.editorTitle.readOnly = false;
    }

    renderEditorTags(note.tags || []);

    dom.noteList.querySelectorAll('.note-card').forEach(function (card) {
      card.classList.toggle('active', card.dataset.id === noteId);
    });
  }

  function showEditor(show) {
    dom.editorEmpty.style.display = show ? 'none' : '';
    dom.editorContent.style.display = show ? '' : 'none';
  }

  function updateStarButton(starred) {
    const icon = dom.btnToggleStar.querySelector('i');
    if (starred) {
      icon.className = 'fa-solid fa-star';
      dom.btnToggleStar.classList.add('starred');
    } else {
      icon.className = 'fa-regular fa-star';
      dom.btnToggleStar.classList.remove('starred');
    }
  }

  function renderEditorTags(tagsList) {
    let html = '';
    tagsList.forEach(function (tag) {
      html += '<span class="editor-tag">'
        + escapeHtml(tag)
        + ' <i class="fa-solid fa-xmark remove-tag" data-tag="' + escapeHtml(tag) + '"></i>'
        + '</span>';
    });
    dom.editorTags.innerHTML = html;

    dom.editorTags.querySelectorAll('.remove-tag').forEach(function (btn) {
      btn.addEventListener('click', function () {
        removeTag(btn.dataset.tag);
      });
    });
  }

  // ===== 태그 관리 =====

  async function addTag(tagName) {
    if (!currentNoteId) {
      return;
    }

    const trimmed = tagName.trim();
    if (!trimmed) {
      return;
    }

    const note = findNote(currentNoteId);
    if (note && note.tags && note.tags.includes(trimmed)) {
      return;
    }

    await api('POST', '/api/notes/' + currentNoteId + '/tags', { tag: trimmed });

    if (note && note.tags) {
      note.tags.push(trimmed);
    }

    renderEditorTags(note ? note.tags : []);
    await Promise.all([loadTags(), loadNotes()]);
    updateSidebarLists();
    renderNoteList();
  }

  async function removeTag(tagName) {
    if (!currentNoteId) {
      return;
    }

    await api('DELETE', '/api/notes/' + currentNoteId + '/tags/' + encodeURIComponent(tagName));

    const note = findNote(currentNoteId);
    if (note && note.tags) {
      note.tags = note.tags.filter(function (t) { return t !== tagName; });
    }

    renderEditorTags(note ? note.tags : []);
    await Promise.all([loadTags(), loadNotes()]);
    updateSidebarLists();
    renderNoteList();
  }

  // ===== 노트북 관리 =====

  async function createNotebook() {
    const name = prompt('새 노트북 이름:');
    if (!name || !name.trim()) {
      return;
    }

    try {
      await api('POST', '/api/notebooks', { name: name.trim() });
      await loadNotebooks();
      updateSidebarLists();
    } catch (err) {
      alert(err.message);
    }
  }

  async function deleteNotebook(nbId, nbName) {
    if (!confirm('"' + nbName + '" 노트북을 삭제하시겠습니까?\n해당 노트북의 메모는 기본 노트북으로 이동됩니다.')) {
      return;
    }

    try {
      await api('DELETE', '/api/notebooks/' + nbId);

      if (currentFilter === 'notebook:' + nbName) {
        setFilter('all');
      }

      await refreshAll();
    } catch (err) {
      alert(err.message);
    }
  }

  async function changeNoteNotebook(noteId, nbId, nbName) {
    await api('PUT', '/api/notes/' + noteId, { notebook_id: nbId });
    dom.editorNotebookName.textContent = nbName;
    await refreshAll();
  }

  // ===== 카운트 업데이트 =====

  async function updateCountsFromServer() {
    try {
      const [allNotes, starredNotes, trashedNotes] = await Promise.all([
        api('GET', '/api/notes'),
        api('GET', '/api/notes?filter=starred'),
        api('GET', '/api/notes?filter=trash'),
      ]);
      dom.countAll.textContent = allNotes.length;
      dom.countStarred.textContent = starredNotes.length;
      dom.countTrash.textContent = trashedNotes.length;
    } catch (err) {
      console.error('카운트 업데이트 오류:', err);
    }
  }

  // ===== 사이드바 업데이트 =====

  function updateSidebarLists() {
    let nbHtml = '';
    notebooks.forEach(function (nb) {
      const isActive = currentFilter === 'notebook:' + nb.name ? ' active' : '';
      const isDefault = nb.name === '기본 노트북';
      const deleteBtn = !isDefault
        ? '<button class="btn-icon notebook-delete" data-id="' + nb.id + '" data-name="' + escapeHtml(nb.name) + '" title="삭제"><i class="fa-solid fa-xmark"></i></button>'
        : '';

      nbHtml += '<div class="notebook-item' + isActive + '" data-name="' + escapeHtml(nb.name) + '" data-id="' + nb.id + '">'
        + '<i class="fa-solid fa-book-open"></i>'
        + '<span>' + escapeHtml(nb.name) + '</span>'
        + '<span class="note-count">' + (parseInt(nb.note_count) || 0) + '</span>'
        + deleteBtn
        + '</div>';
    });
    dom.notebookList.innerHTML = nbHtml;

    dom.notebookList.querySelectorAll('.notebook-item').forEach(function (item) {
      item.addEventListener('click', function (e) {
        if (e.target.closest('.notebook-delete')) {
          return;
        }
        setFilter('notebook:' + item.dataset.name);
      });
    });

    dom.notebookList.querySelectorAll('.notebook-delete').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        deleteNotebook(btn.dataset.id, btn.dataset.name);
      });
    });

    let tagHtml = '';
    tags.forEach(function (t) {
      const isActive = currentFilter === 'tag:' + t.tag ? ' active' : '';
      tagHtml += '<div class="tag-item' + isActive + '" data-tag="' + escapeHtml(t.tag) + '">'
        + '<i class="fa-solid fa-circle"></i>'
        + '<span>' + escapeHtml(t.tag) + '</span>'
        + '<span class="note-count">' + t.count + '</span>'
        + '</div>';
    });
    dom.tagList.innerHTML = tagHtml;

    dom.tagList.querySelectorAll('.tag-item').forEach(function (item) {
      item.addEventListener('click', function () {
        setFilter('tag:' + item.dataset.tag);
      });
    });
  }

  // ===== 노트북 드롭다운 =====

  function showNotebookDropdown() {
    const note = findNote(currentNoteId);
    let html = '';
    notebooks.forEach(function (nb) {
      const isActive = note && note.notebook_id === nb.id ? ' active' : '';
      html += '<div class="dropdown-item' + isActive + '" data-id="' + nb.id + '" data-name="' + escapeHtml(nb.name) + '">'
        + '<i class="fa-solid fa-book-open"></i> '
        + escapeHtml(nb.name)
        + '</div>';
    });

    dom.notebookDropdown.innerHTML = html;
    dom.notebookDropdown.style.display = 'block';

    const rect = dom.btnNoteNotebook.getBoundingClientRect();
    dom.notebookDropdown.style.left = rect.left + 'px';
    dom.notebookDropdown.style.top = (rect.bottom + 4) + 'px';

    dom.notebookDropdown.querySelectorAll('.dropdown-item').forEach(function (item) {
      item.addEventListener('click', function () {
        changeNoteNotebook(currentNoteId, parseInt(item.dataset.id), item.dataset.name);
        hideNotebookDropdown();
      });
    });
  }

  function hideNotebookDropdown() {
    dom.notebookDropdown.style.display = 'none';
  }

  // ===== 서식 명령 =====

  function execFormatCommand(command) {
    if (command.startsWith('formatBlock-')) {
      const tag = command.replace('formatBlock-', '');
      document.execCommand('formatBlock', false, '<' + tag + '>');
    } else {
      document.execCommand(command, false, null);
    }
    dom.editorBody.focus();
  }

  // ===== 이벤트 바인딩 =====

  function bindEvents() {
    dom.btnNewNote.addEventListener('click', createNote);
    dom.btnNewNotebook.addEventListener('click', createNotebook);

    dom.navItems.forEach(function (item) {
      item.addEventListener('click', function () {
        setFilter(item.dataset.filter);
      });
    });

    let searchTimer = null;
    dom.searchInput.addEventListener('input', function () {
      if (searchTimer) {
        clearTimeout(searchTimer);
      }
      searchTimer = setTimeout(function () {
        loadNotes().then(renderNoteList);
      }, 300);
    });

    dom.sortSelect.addEventListener('change', function () {
      loadNotes().then(renderNoteList);
    });

    dom.editorTitle.addEventListener('input', scheduleSave);
    dom.editorBody.addEventListener('input', scheduleSave);

    dom.tagInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        addTag(dom.tagInput.value);
        dom.tagInput.value = '';
      }
    });

    dom.btnToggleStar.addEventListener('click', async function () {
      if (!currentNoteId) {
        return;
      }
      const note = findNote(currentNoteId);
      if (!note) {
        return;
      }
      const newStarred = !note.starred;
      await api('PUT', '/api/notes/' + currentNoteId, { starred: newStarred });
      note.starred = newStarred;
      updateStarButton(newStarred);
      await refreshAll();
    });

    dom.btnDeleteNote.addEventListener('click', function () {
      if (currentNoteId) {
        deleteNote(currentNoteId);
      }
    });

    dom.btnRestoreNote.addEventListener('click', function () {
      if (currentNoteId) {
        restoreNote(currentNoteId);
      }
    });

    dom.btnPermanentDelete.addEventListener('click', function () {
      if (currentNoteId && confirm('이 메모를 영구적으로 삭제하시겠습니까?')) {
        deleteNote(currentNoteId);
      }
    });

    dom.btnNoteNotebook.addEventListener('click', function (e) {
      e.stopPropagation();
      if (dom.notebookDropdown.style.display === 'none') {
        showNotebookDropdown();
      } else {
        hideNotebookDropdown();
      }
    });

    document.addEventListener('click', function () {
      hideNotebookDropdown();
    });

    dom.fmtBtns.forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        execFormatCommand(btn.dataset.command);
      });
    });

    document.addEventListener('keydown', function (e) {
      if (e.ctrlKey && e.key === 'n') {
        e.preventDefault();
        createNote();
      }
      if (e.ctrlKey && e.key === 's') {
        e.preventDefault();
        saveCurrentNote();
      }
    });
  }

  // ===== 초기화 =====

  async function init() {
    bindEvents();
    await refreshAll();
  }

  init();
})();
