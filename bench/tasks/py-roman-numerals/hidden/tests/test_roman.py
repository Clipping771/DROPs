import sys, os, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from roman import to_roman, from_roman

class T(unittest.TestCase):
    def test_to(self):
        for n, r in [(1, 'I'), (4, 'IV'), (9, 'IX'), (14, 'XIV'), (40, 'XL'), (90, 'XC'), (400, 'CD'), (1994, 'MCMXCIV'), (3999, 'MMMCMXCIX')]:
            self.assertEqual(to_roman(n), r)
    def test_roundtrip(self):
        for n in range(1, 4000):
            self.assertEqual(from_roman(to_roman(n)), n)
    def test_invalid(self):
        for s in ['IIII', 'IC', 'ABC', '', 'VV', 'MMMM']:
            with self.assertRaises(ValueError):
                from_roman(s)
