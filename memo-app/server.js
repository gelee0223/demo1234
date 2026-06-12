const express = require('express');
const { createClient } = require('@libsql/client');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Turso DB 연결 ---
const db = createClient({
  url: process.env.TURSO_URL,
  authToken: process.env.TURSO_TOKEN,
});

// --- 미들웨어 ---
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- DB 초기화 ---
async function initDB() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS notebooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      title TEXT DEFAULT '',
      content TEXT DEFAULT '',
      notebook_id INTEGER REFERENCES notebooks(id) ON DELETE SET NULL,
      starred INTEGER DEFAULT 0,
      trashed INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS note_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id TEXT REFERENCES notes(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      UNIQUE(note_id, tag)
    )
  `);

  await db.execute(`
    INSERT OR IGNORE INTO notebooks (name) VALUES ('기본 노트북')
  `);

  console.log('DB 초기화 완료');
}

// --- 헬퍼: 노트에 태그 목록 붙이기 ---
async function attachTags(notes) {
  for (const note of notes) {
    const tagResult = await db.execute({
      sql: 'SELECT tag FROM note_tags WHERE note_id = ?',
      args: [note.id],
    });
    note.tags = tagResult.rows.map(function (r) { return r.tag; });
    note.starred = !!note.starred;
    note.trashed = !!note.trashed;
  }
  return notes;
}

// ===== API: 노트북 =====

app.get('/api/notebooks', async (req, res) => {
  try {
    const result = await db.execute(`
      SELECT nb.id, nb.name,
        (SELECT COUNT(*) FROM notes n WHERE n.notebook_id = nb.id AND n.trashed = 0) AS note_count
      FROM notebooks nb
      ORDER BY nb.created_at
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('노트북 목록 조회 오류:', err);
    res.status(500).json({ error: '서버 오류' });
  }
});

app.post('/api/notebooks', async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: '노트북 이름이 필요합니다' });
  }

  try {
    const result = await db.execute({
      sql: 'INSERT INTO notebooks (name) VALUES (?)',
      args: [name.trim()],
    });
    const nb = await db.execute({
      sql: 'SELECT * FROM notebooks WHERE id = ?',
      args: [result.lastInsertRowid],
    });
    res.status(201).json(nb.rows[0]);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: '이미 존재하는 노트북입니다' });
    }
    console.error('노트북 생성 오류:', err);
    res.status(500).json({ error: '서버 오류' });
  }
});

app.delete('/api/notebooks/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const defaultNb = await db.execute(
      "SELECT id FROM notebooks WHERE name = '기본 노트북'"
    );
    if (defaultNb.rows.length === 0) {
      return res.status(500).json({ error: '기본 노트북을 찾을 수 없습니다' });
    }

    const defaultId = defaultNb.rows[0].id;

    if (Number(id) === Number(defaultId)) {
      return res.status(400).json({ error: '기본 노트북은 삭제할 수 없습니다' });
    }

    await db.execute({
      sql: 'UPDATE notes SET notebook_id = ? WHERE notebook_id = ?',
      args: [defaultId, id],
    });

    await db.execute({
      sql: 'DELETE FROM notebooks WHERE id = ?',
      args: [id],
    });

    res.json({ success: true });
  } catch (err) {
    console.error('노트북 삭제 오류:', err);
    res.status(500).json({ error: '서버 오류' });
  }
});

// ===== API: 노트 =====

app.get('/api/notes', async (req, res) => {
  const { filter, notebook_id, tag, search, sort } = req.query;

  try {
    let whereClause = 'WHERE n.trashed = 0';
    const args = [];

    if (filter === 'starred') {
      whereClause = 'WHERE n.starred = 1 AND n.trashed = 0';
    } else if (filter === 'trash') {
      whereClause = 'WHERE n.trashed = 1';
    } else if (notebook_id) {
      whereClause = 'WHERE n.notebook_id = ? AND n.trashed = 0';
      args.push(notebook_id);
    } else if (tag) {
      whereClause = `WHERE n.trashed = 0 AND EXISTS (
        SELECT 1 FROM note_tags nt WHERE nt.note_id = n.id AND nt.tag = ?
      )`;
      args.push(tag);
    }

    if (search && search.trim()) {
      const searchParam = `%${search.trim().toLowerCase()}%`;
      whereClause += ` AND (
        LOWER(n.title) LIKE ?
        OR LOWER(n.content) LIKE ?
        OR EXISTS (SELECT 1 FROM note_tags nt2 WHERE nt2.note_id = n.id AND LOWER(nt2.tag) LIKE ?)
      )`;
      args.push(searchParam, searchParam, searchParam);
    }

    let orderClause = 'ORDER BY n.updated_at DESC';
    if (sort === 'created') {
      orderClause = 'ORDER BY n.created_at DESC';
    } else if (sort === 'title') {
      orderClause = 'ORDER BY n.title ASC';
    }

    const result = await db.execute({
      sql: `
        SELECT n.id, n.title, n.content, n.notebook_id, nb.name AS notebook_name,
          n.starred, n.trashed, n.created_at, n.updated_at
        FROM notes n
        LEFT JOIN notebooks nb ON nb.id = n.notebook_id
        ${whereClause}
        ${orderClause}
      `,
      args,
    });

    const notes = await attachTags(result.rows);
    res.json(notes);
  } catch (err) {
    console.error('노트 목록 조회 오류:', err);
    res.status(500).json({ error: '서버 오류' });
  }
});

app.post('/api/notes', async (req, res) => {
  const { notebook_id } = req.body;

  try {
    let nbId = notebook_id;
    if (!nbId) {
      const defaultNb = await db.execute(
        "SELECT id FROM notebooks WHERE name = '기본 노트북'"
      );
      nbId = defaultNb.rows[0].id;
    }

    const noteId = crypto.randomUUID();

    await db.execute({
      sql: 'INSERT INTO notes (id, notebook_id) VALUES (?, ?)',
      args: [noteId, nbId],
    });

    const result = await db.execute({
      sql: `SELECT n.*, nb.name AS notebook_name
            FROM notes n LEFT JOIN notebooks nb ON nb.id = n.notebook_id
            WHERE n.id = ?`,
      args: [noteId],
    });

    const note = result.rows[0];
    note.tags = [];
    note.starred = !!note.starred;
    note.trashed = !!note.trashed;

    res.status(201).json(note);
  } catch (err) {
    console.error('노트 생성 오류:', err);
    res.status(500).json({ error: '서버 오류' });
  }
});

app.put('/api/notes/:id', async (req, res) => {
  const { id } = req.params;
  const { title, content, notebook_id, starred, trashed } = req.body;

  try {
    const sets = [];
    const args = [];

    if (title !== undefined) {
      sets.push('title = ?');
      args.push(title);
    }
    if (content !== undefined) {
      sets.push('content = ?');
      args.push(content);
    }
    if (notebook_id !== undefined) {
      sets.push('notebook_id = ?');
      args.push(notebook_id);
    }
    if (starred !== undefined) {
      sets.push('starred = ?');
      args.push(starred ? 1 : 0);
    }
    if (trashed !== undefined) {
      sets.push('trashed = ?');
      args.push(trashed ? 1 : 0);
    }

    if (sets.length === 0) {
      return res.status(400).json({ error: '수정할 필드가 없습니다' });
    }

    sets.push("updated_at = datetime('now')");
    args.push(id);

    await db.execute({
      sql: `UPDATE notes SET ${sets.join(', ')} WHERE id = ?`,
      args,
    });

    const result = await db.execute({
      sql: 'SELECT * FROM notes WHERE id = ?',
      args: [id],
    });

    if (result.rows.length === 0) {
      return res.status(404).json({ error: '노트를 찾을 수 없습니다' });
    }

    const note = result.rows[0];
    note.starred = !!note.starred;
    note.trashed = !!note.trashed;
    res.json(note);
  } catch (err) {
    console.error('노트 수정 오류:', err);
    res.status(500).json({ error: '서버 오류' });
  }
});

app.delete('/api/notes/:id', async (req, res) => {
  const { id } = req.params;

  try {
    await db.execute({ sql: 'DELETE FROM notes WHERE id = ?', args: [id] });
    res.json({ success: true });
  } catch (err) {
    console.error('노트 삭제 오류:', err);
    res.status(500).json({ error: '서버 오류' });
  }
});

// ===== API: 태그 =====

app.get('/api/tags', async (req, res) => {
  try {
    const result = await db.execute(`
      SELECT nt.tag, COUNT(*) AS count
      FROM note_tags nt
      JOIN notes n ON n.id = nt.note_id
      WHERE n.trashed = 0
      GROUP BY nt.tag
      ORDER BY nt.tag
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('태그 목록 조회 오류:', err);
    res.status(500).json({ error: '서버 오류' });
  }
});

app.post('/api/notes/:id/tags', async (req, res) => {
  const { id } = req.params;
  const { tag } = req.body;

  if (!tag || !tag.trim()) {
    return res.status(400).json({ error: '태그 이름이 필요합니다' });
  }

  try {
    await db.execute({
      sql: 'INSERT OR IGNORE INTO note_tags (note_id, tag) VALUES (?, ?)',
      args: [id, tag.trim()],
    });
    await db.execute({
      sql: "UPDATE notes SET updated_at = datetime('now') WHERE id = ?",
      args: [id],
    });
    res.status(201).json({ success: true });
  } catch (err) {
    console.error('태그 추가 오류:', err);
    res.status(500).json({ error: '서버 오류' });
  }
});

app.delete('/api/notes/:noteId/tags/:tag', async (req, res) => {
  const { noteId, tag } = req.params;

  try {
    await db.execute({
      sql: 'DELETE FROM note_tags WHERE note_id = ? AND tag = ?',
      args: [noteId, decodeURIComponent(tag)],
    });
    await db.execute({
      sql: "UPDATE notes SET updated_at = datetime('now') WHERE id = ?",
      args: [noteId],
    });
    res.json({ success: true });
  } catch (err) {
    console.error('태그 삭제 오류:', err);
    res.status(500).json({ error: '서버 오류' });
  }
});

// --- SPA 폴백 ---
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- 서버 시작 ---
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`서버 실행 중: http://localhost:${PORT}`);
  });
}).catch((err) => {
  console.error('DB 초기화 실패:', err);
  process.exit(1);
});
