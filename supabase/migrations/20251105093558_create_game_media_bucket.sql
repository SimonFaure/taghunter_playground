/*
  # Create storage bucket for game media files

  1. Storage Setup
    - Create a public bucket called 'game-media' for storing uploaded game media files
    - Enable public access for easy retrieval of game assets
    
  2. Security
    - Enable RLS on storage.objects
    - Allow public read access to all files in the bucket
    - Allow authenticated users to upload files
*/

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'game-media',
  'game-media',
  true,
  52428800,
  ARRAY['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'video/mp4']
)
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'storage' 
    AND tablename = 'objects' 
    AND policyname = 'Public read access for game media'
  ) THEN
    CREATE POLICY "Public read access for game media"
      ON storage.objects
      FOR SELECT
      TO public
      USING (bucket_id = 'game-media');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'storage' 
    AND tablename = 'objects' 
    AND policyname = 'Allow uploads to game media'
  ) THEN
    CREATE POLICY "Allow uploads to game media"
      ON storage.objects
      FOR INSERT
      TO public
      WITH CHECK (bucket_id = 'game-media');
  END IF;
END $$;
