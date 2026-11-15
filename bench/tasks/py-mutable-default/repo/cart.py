class Cart:
    def __init__(self, items=[]):
        self.items = items

    def add(self, name, qty=1):
        self.items.append((name, qty))
        return self

    def count(self):
        return sum(q for _, q in self.items)
