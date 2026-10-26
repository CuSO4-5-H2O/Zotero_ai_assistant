from pathlib import Path
import unittest,tempfile,pathlib,json,sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from dock_bridge import DockBridge
def atomic(path,text):path.write_text(text,encoding='utf-8')
class BridgeTests(unittest.TestCase):
 def test_restart_preserves_events_and_sequence(self):
  with tempfile.TemporaryDirectory() as folder:
   p=pathlib.Path(folder)/'bridge.json';a=DockBridge(p,atomic);channel=a.create()['channel']
   a.publish(channel,{'type':'home'});b=DockBridge(p,atomic)
   self.assertEqual(b.events(channel,0,wait=0)['events'][0]['sequence'],1)
   self.assertEqual(b.publish(channel,{'type':'home'})['sequence'],2)
   self.assertEqual(len(b.events(channel,1,wait=0)['events']),1)
 def test_old_window_recovers_unknown_channel(self):
  a=DockBridge();channel='a'*32
  result=a.events(channel,99,wait=0);self.assertTrue(result['reset']);self.assertEqual(result['sequence'],0)
  a.publish(channel,{'type':'home'});self.assertEqual(a.events(channel,0,wait=0)['events'][0]['sequence'],1)
 def test_publish_before_old_poll(self):
  a=DockBridge();channel='b'*32;a.publish(channel,{'type':'home'})
  result=a.events(channel,99,wait=0);self.assertTrue(result['reset']);self.assertEqual(result['events'][0]['sequence'],1)
 def test_invalid_channel_rejected_and_channels_bounded(self):
  a=DockBridge()
  with self.assertRaises(ValueError):a.events('wrong',0,wait=0)
  for i in range(40):a.events(format(i,'032x'),0,wait=0)
  self.assertEqual(len(a.channels),32)
if __name__=='__main__':unittest.main(verbosity=2)
