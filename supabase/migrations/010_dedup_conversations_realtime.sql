-- Bug 5: Merge duplicate conversations per contact and add UNIQUE constraint
-- Bug 6: Add contacts table to realtime publication

-- Step 1: Move all messages from duplicate conversations to the oldest one per contact
WITH ranked AS (
  SELECT id, organization_id, contact_id,
         ROW_NUMBER() OVER (PARTITION BY organization_id, contact_id ORDER BY created_at ASC) AS rn
  FROM conversations
),
keeper AS (
  SELECT id AS keep_id, organization_id, contact_id
  FROM ranked WHERE rn = 1
),
dupe AS (
  SELECT c.id AS dupe_id, k.keep_id
  FROM conversations c
  JOIN keeper k ON k.organization_id = c.organization_id AND k.contact_id = c.contact_id
  WHERE c.id != k.keep_id
)
UPDATE messages m
SET conversation_id = d.keep_id
FROM dupe d
WHERE m.conversation_id = d.dupe_id;

-- Step 2: Delete duplicate conversations (messages already moved)
WITH ranked AS (
  SELECT id, organization_id, contact_id,
         ROW_NUMBER() OVER (PARTITION BY organization_id, contact_id ORDER BY created_at ASC) AS rn
  FROM conversations
)
DELETE FROM conversations WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- Step 3: Add unique constraint to prevent future duplicates
ALTER TABLE conversations
  ADD CONSTRAINT conversations_org_contact_unique UNIQUE (organization_id, contact_id);

-- Step 4: Add contacts to realtime publication (Bug 6)
ALTER PUBLICATION supabase_realtime ADD TABLE contacts;
