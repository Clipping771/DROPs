import sys, os, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from cart import Cart

class T(unittest.TestCase):
    def test_independent(self):
        a = Cart().add('x', 2)
        b = Cart()
        self.assertEqual(b.count(), 0)
        self.assertEqual(a.count(), 2)
    def test_given_list_not_aliased(self):
        src = [('y', 1)]
        c = Cart(src).add('z')
        self.assertEqual(len(src), 1)
        self.assertEqual(c.count(), 2)
