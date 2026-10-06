-- Private photo storage (Prompt 3). Files are never public; the app asks for short-lived
-- signed links. Images only, 5 MB maximum. File path convention: "<submission_id>/<file name>".

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('attachments', 'attachments', false, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/heic'])
on conflict (id) do update
  set public = false, file_size_limit = 5242880,
      allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/heic'];

create policy attachments_bucket_read on storage.objects for select to authenticated
  using (bucket_id = 'attachments' and (
    public.owns_submission(((storage.foldername(name))[1])::uuid)
    or public.staff_can_see_submission(((storage.foldername(name))[1])::uuid)));

create policy attachments_bucket_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'attachments' and (
    public.owns_submission(((storage.foldername(name))[1])::uuid)
    or public.staff_can_see_submission(((storage.foldername(name))[1])::uuid)));
-- No update or delete policies: uploaded evidence cannot be changed by users.
