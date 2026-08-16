import unittest, pathlib, py_compile
class TestPublisher(unittest.TestCase):
    def test_compiles(self): py_compile.compile(str(pathlib.Path(__file__).parents[1]/'python'/'publish_strategy_snapshot.py'),doraise=True)
if __name__=='__main__': unittest.main()
