"""派单校验的离线回归测试，不依赖本机档位或网络。"""
import json
import os
from pathlib import Path
import subprocess
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'tools' / 'dispatch-check.sh'


class DispatchCheckTests(unittest.TestCase):
    def run_check(self, preset='review', engine='codex', mode='task',
                  prompt='做一个独立小改动', extra=()):
        status = dict(collab=dict(preset=preset, voice='off', longtask='manual'),
                      engine=dict(active=engine))
        return subprocess.run(
            ['bash', str(SCRIPT), '--status-json', json.dumps(status),
             '--mode', mode, '--prompt', prompt, *extra],
            capture_output=True, text=True)

    def test_review_task(self):
        r = self.run_check()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('档位: review', r.stdout)

    def test_review_requires_codex(self):
        r = self.run_check(engine='claude', mode='review')
        self.assertEqual(r.returncode, 1)
        self.assertIn('复核恒走 codex', r.stdout)

    def test_propose_marker(self):
        self.assertEqual(self.run_check(preset='propose').returncode, 1)
        self.assertEqual(self.run_check(preset='propose', prompt='工作\nLONGSESSION: yes/no').returncode, 0)

    def test_longtask_short_task(self):
        r = self.run_check(preset='longtask')
        self.assertEqual(r.returncode, 0)
        self.assertIn('ℹ️ R5 独立短活', r.stdout)

    def test_review_longtask_warning(self):
        r = self.run_check(mode='longtask')
        self.assertEqual(r.returncode, 0)
        self.assertIn('⚠️ R4', r.stdout)

    def test_claude_analysis(self):
        r = self.run_check(engine='claude', prompt='只分析此问题')
        self.assertEqual(r.returncode, 1)
        self.assertIn('claude 无外部产物', r.stdout)

    def test_json_consistency_and_order(self):
        for preset in ('review', 'propose'):
            r = self.run_check(preset=preset, extra=('--json',))
            data = json.loads(r.stdout)
            self.assertIs(data['blocked'], r.returncode == 1)
            self.assertIs(data['ok'], r.returncode == 0)
            self.assertEqual(data['checks'][0]['code'], 'R1')

    def test_bad_status(self):
        for raw in ('bad', '{}', 'null', '[]'):
            r = self.run_check(extra=('--status-json', raw, '--json'))
            data = json.loads(r.stdout)
            self.assertEqual(r.returncode, 1)
            self.assertEqual(data['checks'][0]['code'], 'R1')
            self.assertIsNone(data['preset'])
            self.assertIn('复核', data['channel'])

    def test_empty_task_and_pi(self):
        r = self.run_check(engine='pi', prompt=' ')
        self.assertEqual(r.returncode, 1)
        self.assertIn('R7', r.stdout)
        self.assertIn('R8', r.stdout)

    def test_prompt_file(self):
        # 读取已有测试文件，避免测试产生临时工单文件。
        r = self.run_check(prompt='', extra=('--prompt-file', str(Path(__file__).resolve())))
        self.assertEqual(r.returncode, 0)
        r = self.run_check(extra=('--prompt-file', str(SCRIPT / '不存在')))
        self.assertEqual(r.returncode, 1)
        self.assertIn('无法读取 prompt 文件', r.stdout)

    def test_environment_status(self):
        env = dict(os.environ, SECOND_ENGINE_STATUS_JSON=json.dumps(dict(
            collab=dict(preset='review', voice='off', longtask='manual'),
            engine=dict(active='codex'))))
        r = subprocess.run(['bash', str(SCRIPT), '--prompt', '独立工作', '--json'],
                           env=env, text=True, capture_output=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)['engine'], 'codex')

    def test_engine_override(self):
        r = self.run_check(engine='claude', mode='review', extra=('--engine', 'codex'))
        self.assertEqual(r.returncode, 0)

    def test_argument_errors(self):
        for args in (('--engine', 'other'), ('--prompt-file',), ('--unknown',)):
            r = self.run_check(extra=args)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn('usage:', r.stderr)


if __name__ == '__main__':
    unittest.main()
