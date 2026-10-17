import { MigrationInterface, QueryRunner } from 'typeorm';
export class AddParentMobilePush1791701000000 implements MigrationInterface {
  async up(r: QueryRunner) {
    await r.query(`CREATE TABLE parent_mobile_devices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      parent_id uuid NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
      device_id uuid NOT NULL, token text NOT NULL UNIQUE,
      platform varchar(7) NOT NULL CHECK(platform IN ('android','ios')),
      language varchar(2) NOT NULL CHECK(language IN ('en','lo')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(parent_id,device_id))`);
    await r.query(`CREATE TABLE parent_mobile_deliveries (
      device_id uuid NOT NULL REFERENCES parent_mobile_devices(id) ON DELETE CASCADE,
      notification_id uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
      attempts integer NOT NULL DEFAULT 0, delivered_at timestamptz,
      retry_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(device_id,notification_id))`);
  }
  async down(r: QueryRunner) {
    await r.query('DROP TABLE parent_mobile_deliveries');
    await r.query('DROP TABLE parent_mobile_devices');
  }
}
