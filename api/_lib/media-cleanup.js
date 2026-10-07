// Retention for class photos and videos (run by the scheduler together with the other checks).
// Items older than the period admin chose are archived (hidden from families, kept) or deleted (file and record);
// items an admin removed are purged for good after 30 days. Files are deleted BEFORE their records, so a failure
// leaves a record that is simply tried again on the next run.
async function cleanupMedia(client) {
  const rows = await client.call("/rest/v1/rpc/cka_media_expired", { method: "POST", body: {} });
  if (!rows || !rows.length) return { archived: 0, deleted: 0, failed: 0 };
  const archive = rows.filter((r) => r.action === "archive").map((r) => r.id);
  const del = rows.filter((r) => r.action === "delete");
  let archived = 0, deleted = 0, failed = 0;
  if (archive.length) archived = Number(await client.call("/rest/v1/rpc/cka_media_apply", { method: "POST", body: { p_ids: archive, p_action: "archive" } })) || 0;
  for (let i = 0; i < del.length; i += 50) {
    const batch = del.slice(i, i + 50);
    try {
      await client.call("/storage/v1/object/media", { method: "DELETE", body: { prefixes: batch.map((r) => r.storage_path) } });
      deleted += Number(await client.call("/rest/v1/rpc/cka_media_apply", { method: "POST", body: { p_ids: batch.map((r) => r.id), p_action: "delete" } })) || 0;
    } catch (e) { failed += batch.length; }
  }
  return { archived, deleted, failed };
}
module.exports = { cleanupMedia };
