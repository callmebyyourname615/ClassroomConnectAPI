import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddParentWebPush1791700000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE parent_push_subscriptions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      parent_id uuid NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
      endpoint text NOT NULL UNIQUE,
      p256dh text NOT NULL,
      auth text NOT NULL,
      language varchar(2) NOT NULL DEFAULT 'lo',
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await runner.query(
      `CREATE INDEX IDX_PUSH_PARENT ON parent_push_subscriptions(parent_id)`,
    );
    await runner.query(`CREATE TABLE parent_push_deliveries (
      subscription_id uuid NOT NULL REFERENCES parent_push_subscriptions(id) ON DELETE CASCADE,
      notification_id uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
      attempts integer NOT NULL DEFAULT 0,
      delivered_at timestamptz,
      retry_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (subscription_id, notification_id)
    )`);
    await runner.query(
      `CREATE INDEX IDX_NOTIFICATION_PUSH_PARENT_DATE ON notifications(parent_id, created_at) WHERE is_deleted = false`,
    );
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query(
      'DROP INDEX IF EXISTS IDX_NOTIFICATION_PUSH_PARENT_DATE',
    );
    await runner.query('DROP TABLE parent_push_deliveries');
    await runner.query('DROP TABLE parent_push_subscriptions');
  }
}
