const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// --- PostgreSQL 연결 ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// --- 미들웨어 ---
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- DB 초기화 ---
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS notebooks (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS notes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title VARCHAR(500) DEFAULT '',
        content TEXT DEFAULT '',
        notebook_id INTEGER REFERENCES notebooks(id) ON DELETE SET NULL,
        starred BOOLEAN DEFAULT false,
        trashed BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS note_tags (
        id SERIAL PRIMARY KEY,
        note_id UUID REFERENCES notes(id) ON DELETE CASCADE,
        tag VARCHAR(100) NOT NULL,
        UNIQUE(note_id, tag)
      )
    `);

    // 기본 노트북 생성
    await client.query(`
      INSERT INTO notebooks (name) VALUES ('기본 노트북')
      ON CONFLICT (name) DO NOTHING
    `);

    console.log('DB 초기화 완료');
  } finally {
    client.release();
  }
}

// ===== API: 노트북 =====

// 노트북 목록 조회
app.get('/api/notebooks', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT nb.id, nb.name,
        COUNT(n.id) FILTER (WHERE n.trashed = false) AS note_count
      FROM notebooks nb
      LEFT JOIN notes n ON n.notebook_id = nb.id
      GROUP BY nb.id, nb.name
      ORDER BY nb.created_at
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('노트북 목록 조회 오류:', err);
    res.status(500).json({ error: '서버 오류' });
  }
});

// 노트북 생성
app.post('/api/notebooks', async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: '노트북 이름이 필요합니다' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO notebooks (name) VALUES ($1) RETURNING *',
      [name.trim()]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: '이미 존재하는 노트북입니다' });
    }
    console.error('노트북 생성 오류:', err);
    res.status(500).json({ error: '서버 오류' });
  }
});

// 노트북 삭제 (메모는 기본 노트북으로 이동)
app.delete('/api/notebooks/:id', async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 기본 노트북 확인
    const defaultNb = await client.query(
      "SELECT id FROM notebooks WHERE name = '기본 노트북'"
    );
    if (defaultNb.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(500).json({ error: '기본 노트북을 찾을 수 없습니다' });
    }

    const defaultId = defaultNb.rows[0].id;

    // 기본 노트북은 삭제 불가
    if (parseInt(id) === defaultId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '기본 노트북은 삭제할 수 없습니다' });
    }

    // 해당 노트북의 메모를 기본 노트북으로 이동
    await client.query(
      'UPDATE notes SET notebook_id = $1 WHERE notebook_id = $2',
      [defaultId, id]
    );

    // 노트북 삭제
    await client.query('DELETE FROM notebooks WHERE id = $1', [id]);

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('노트북 삭제 오류:', err);
    res.status(500).json({ error: '서버 오류' });
  } finally {
    client.release();
  }
});

// ===== API: 노트 =====

// 노트 목록 조회
app.get('/api/notes', async (req, res) => {
  const { filter, notebook_id, tag, search, sort } = req.query;

  try {
    let whereClause = '';
    const params = [];

    if (filter === 'starred') {
      whereClause = 'WHERE n.starred = true AND n.trashed = false';
    } else if (filter === 'trash') {
      whereClause = 'WHERE n.trashed = true';
    } else if (notebook_id) {
      whereClause = 'WHERE n.notebook_id = $1 AND n.trashed = false';
      params.push(notebook_id);
    } else if (tag) {
      whereClause = `WHERE n.trashed = false AND EXISTS (
        SELECT 1 FROM note_tags nt WHERE nt.note_id = n.id AND nt.tag = $1
      )`;
      params.push(tag);
    } else {
      whereClause = 'WHERE n.trashed = false';
    }

    // 검색
    if (search && search.trim()) {
      const searchParam = `%${search.trim().toLowerCase()}%`;
      const paramIdx = params.length + 1;
      whereClause += ` AND (
        LOWER(n.title) LIKE $${paramIdx}
        OR LOWER(n.content) LIKE $${paramIdx}
        OR EXISTS (SELECT 1 FROM note_tags nt2 WHERE nt2.note_id = n.id AND LOWER(nt2.tag) LIKE $${paramIdx})
      )`;
      params.push(searchParam);
    }

    // 정렬
    let orderClause = 'ORDER BY n.updated_at DESC';
    if (sort === 'created') {
      orderClause = 'ORDER BY n.created_at DESC';
    } else if (sort === 'title') {
      orderClause = 'ORDER BY n.title ASC';
    }

    const result = await pool.query(`
      SELECT n.id, n.title, n.content, n.notebook_id, nb.name AS notebook_name,
        n.starred, n.trashed, n.created_at, n.updated_at,
        COALESCE(
          (SELECT json_agg(nt.tag) FROM note_tags nt WHERE nt.note_id = n.id),
          '[]'::json
        ) AS tags
      FROM notes n
      LEFT JOIN notebooks nb ON nb.id = n.notebook_id
      ${whereClause}
      ${orderClause}
    `, params);

    res.json(result.rows);
  } catch (err) {
    console.error('노트 목록 조회 오류:', err);
    res.status(500).json({ error: '서버 오류' });
  }
});

// 노트 생성
app.post('/api/notes', async (req, res) => {
  const { notebook_id } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    let nbId = notebook_id;
    if (!nbId) {
      const defaultNb = await client.query(
        "SELECT id FROM notebooks WHERE name = '기본 노트북'"
      );
      nbId = defaultNb.rows[0].id;
    }

    const result = await client.query(
      'INSERT INTO notes (notebook_id) VALUES ($1) RETURNING *',
      [nbId]
    );

    const note = result.rows[0];

    const nbResult = await client.query(
      'SELECT name FROM notebooks WHERE id = $1',
      [nbId]
    );

    await client.query('COMMIT');

    res.status(201).json({
      ...note,
      notebook_name: nbResult.rows[0].name,
      tags: [],
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('노트 생성 오류:', err);
    res.status(500).json({ error: '서버 오류' });
  } finally {
    client.release();
  }
});

// 노트 수정
app.put('/api/notes/:id', async (req, res) => {
  const { id } = req.params;
  const { title, content, notebook_id, starred, trashed } = req.body;

  try {
    const fields = [];
    const params = [];
    let paramIdx = 1;

    if (title !== undefined) {
      fields.push(`title = $${paramIdx++}`);
      params.push(title);
    }
    if (content !== undefined) {
      fields.push(`content = $${paramIdx++}`);
      params.push(content);
    }
    if (notebook_id !== undefined) {
      fields.push(`notebook_id = $${paramIdx++}`);
      params.push(notebook_id);
    }
    if (starred !== undefined) {
      fields.push(`starred = $${paramIdx++}`);
      params.push(starred);
    }
    if (trashed !== undefined) {
      fields.push(`trashed = $${paramIdx++}`);
      params.push(trashed);
    }

    if (fields.length === 0) {
      return res.status(400).json({ error: '수정할 필드가 없습니다' });
    }

    fields.push('updated_at = NOW()');
    params.push(id);

    const result = await pool.query(
      `UPDATE notes SET ${fields.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: '노트를 찾을 수 없습니다' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('노트 수정 오류:', err);
    res.status(500).json({ error: '서버 오류' });
  }
});

// 노트 영구 삭제
app.delete('/api/notes/:id', async (req, res) => {
  const { id } = req.params;

  try {
    await pool.query('DELETE FROM notes WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('노트 삭제 오류:', err);
    res.status(500).json({ error: '서버 오류' });
  }
});

// ===== API: 태그 =====

// 모든 태그 목록
app.get('/api/tags', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT nt.tag, COUNT(*) AS count
      FROM note_tags nt
      JOIN notes n ON n.id = nt.note_id
      WHERE n.trashed = false
      GROUP BY nt.tag
      ORDER BY nt.tag
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('태그 목록 조회 오류:', err);
    res.status(500).json({ error: '서버 오류' });
  }
});

// 노트에 태그 추가
app.post('/api/notes/:id/tags', async (req, res) => {
  const { id } = req.params;
  const { tag } = req.body;

  if (!tag || !tag.trim()) {
    return res.status(400).json({ error: '태그 이름이 필요합니다' });
  }

  try {
    await pool.query(
      'INSERT INTO note_tags (note_id, tag) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [id, tag.trim()]
    );
    await pool.query('UPDATE notes SET updated_at = NOW() WHERE id = $1', [id]);
    res.status(201).json({ success: true });
  } catch (err) {
    console.error('태그 추가 오류:', err);
    res.status(500).json({ error: '서버 오류' });
  }
});

// 노트에서 태그 삭제
app.delete('/api/notes/:noteId/tags/:tag', async (req, res) => {
  const { noteId, tag } = req.params;

  try {
    await pool.query(
      'DELETE FROM note_tags WHERE note_id = $1 AND tag = $2',
      [noteId, decodeURIComponent(tag)]
    );
    await pool.query('UPDATE notes SET updated_at = NOW() WHERE id = $1', [noteId]);
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
