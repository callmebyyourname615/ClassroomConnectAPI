import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

BASE = Path(__file__).resolve().parent
OLD = 'ghcr.io/callmebyyourname615/alpha_api@sha256:' + '1' * 64
NEW = 'ghcr.io/callmebyyourname615/alpha_api@sha256:' + '2' * 64
MOCK = r'''#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
name=Path(sys.argv[0]).name
args=sys.argv[1:]
root=Path(os.environ['MOCK_ROOT'])
mode=os.environ['MOCK_MODE']
with (root/'events').open('a') as f: f.write(json.dumps([name,args,str(Path.cwd())])+'\n')
def fail_once(stage):
 p=root/stage
 if mode==stage and not p.exists(): p.touch(); sys.exit(1)
if name=='id': print(0)
elif name=='curl':
 fail_once('health-fail')
 print('{"status":"ok","database":"ok"}')
elif name=='runuser':
 if 'pg_dump' in args: fail_once('backup-fail'); print('mock-dump')
elif name=='docker':
 if 'login' in args: sys.stdin.read()
 if 'pull' in args: fail_once('pull-fail')
 if 'inspect' in args: print(os.environ['OLD_IMAGE'])
 if 'compose' in args:
  if 'config' in args and '--format' in args:
   lines=Path('.env').read_text().splitlines()
   image=next(x.split('=',1)[1] for x in lines if x.startswith('API_IMAGE='))
   print(json.dumps({'services':{'api':{'image':image}}}))
  if 'ps' in args: print('mock-api-container')
  if 'run' in args and 'migration:run' in args: fail_once('migration-fail')
  if 'up' in args:
   assert args[-1]=='api',args
   fail_once('start-fail')
'''

class DeploymentTests(unittest.TestCase):
    def exercise(self, mode):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            apps = root / 'apps'
            for school in ('svtn', 'aims'):
                d = apps / school
                d.mkdir(parents=True)
                (d / 'compose.yaml').write_text('services: {}\n')
                (d / 'compose.release.yaml').write_text('frontend-unchanged\n')
                (d / '.env').write_text('API_IMAGE=' + OLD + '\nFRONTEND_IMAGE=unchanged\nCOMPOSE_FILE=compose.yaml:compose.release.yaml\n')
                (d / 'api.env').write_text('credentials-unchanged\n')
            bin_dir = root / 'bin'
            bin_dir.mkdir()
            for command in ('id', 'flock', 'docker', 'curl', 'runuser'):
                p = bin_dir / command
                p.write_text(MOCK)
                p.chmod(0o755)
            script = root / 'deploy.sh'
            script.write_text((BASE / 'deploy-api.sh').read_text().replace('/opt/classroomconnect', str(apps)))
            env = dict(os.environ, PATH=str(bin_dir) + ':' + os.environ['PATH'], MOCK_ROOT=str(root), MOCK_MODE=mode, OLD_IMAGE=OLD)
            result = subprocess.run(['bash', str(script), NEW, 'a' * 40, 'workflow-user'], env=env, input='private-test-token', text=True, capture_output=True)
            events = [json.loads(line) for line in (root / 'events').read_text().splitlines()]
            self.assertNotIn('private-test-token', result.stdout + result.stderr + (root / 'events').read_text())
            for school in ('svtn', 'aims'):
                d = apps / school
                self.assertEqual((d / 'api.env').read_text(), 'credentials-unchanged\n')
                self.assertEqual((d / 'compose.release.yaml').read_text(), 'frontend-unchanged\n')
            if mode == 'success':
                self.assertEqual(result.returncode, 0, result.stderr)
                for school in ('svtn', 'aims'):
                    d = apps / school
                    self.assertIn(NEW, (d / '.env').read_text())
                    self.assertIn('\tsuccess\t', (d / 'releases/api.tsv').read_text())
                    self.assertEqual(len(list((d / 'releases/backups').glob('*/database.dump'))), 1)
                dumps = [i for i,e in enumerate(events) if e[0]=='runuser' and 'pg_dump' in e[1]]
                migrations = [i for i,e in enumerate(events) if 'migration:run' in e[1]]
                self.assertEqual(len(migrations), 2)
                self.assertTrue(all(d < m for d,m in zip(dumps,migrations)))
            else:
                self.assertNotEqual(result.returncode, 0)
                for school in ('svtn', 'aims'):
                    self.assertIn(OLD, (apps / school / '.env').read_text())
                self.assertFalse((apps / 'aims/releases/api.tsv').exists())
                if mode == 'backup-fail':
                    self.assertFalse(any('migration:run' in e[1] for e in events))
                if mode == 'pull-fail':
                    self.assertFalse(any('stop' in e[1] for e in events))
                else:
                    self.assertIn('image-restored', (apps / 'svtn/releases/api.tsv').read_text())

    def test_success(self): self.exercise('success')
    def test_registry_failure_preserves_services(self): self.exercise('pull-fail')
    def test_backup_failure_prevents_migration(self): self.exercise('backup-fail')
    def test_migration_failure_restores_image(self): self.exercise('migration-fail')
    def test_start_failure_restores_image(self): self.exercise('start-fail')
    def test_health_failure_restores_image(self): self.exercise('health-fail')
    def test_dispatch_rejects_shell_and_wrong_package(self):
        for command in ('check', 'bash', 'deploy '+NEW+' '+('a'*40)+' user; id', 'deploy ghcr.io/other/api@sha256:'+('2'*64)+' '+('a'*40)+' user'):
            result=subprocess.run(['bash', str(BASE/'api-dispatch.sh')], env=dict(os.environ, SSH_ORIGINAL_COMMAND=command), capture_output=True)
            self.assertEqual(result.returncode, 2)

if __name__ == '__main__': unittest.main()
