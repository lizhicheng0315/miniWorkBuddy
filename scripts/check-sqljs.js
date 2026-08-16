const initSqlJs = require('sql.js');
initSqlJs().then((SQL) => {
  const db = new SQL.Database();
  db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
  db.run("INSERT INTO t (name) VALUES ('hello'),('world')");
  const r = db.exec('SELECT * FROM t');
  console.log(JSON.stringify(r));
});
