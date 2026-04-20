/*
  # Allow media mime types in resources bucket

  The resources bucket was missing image, audio, and video mime types,
  causing scenario media file uploads to fail. This migration adds all
  required media types to the bucket's allowed_mime_types list.
*/

UPDATE storage.buckets
SET allowed_mime_types = array[
  'application/json',
  'text/csv',
  'text/plain',
  'application/octet-stream',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'video/mp4',
  'video/webm',
  'video/ogg'
]
WHERE id = 'resources';
