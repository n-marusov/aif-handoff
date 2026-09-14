# RDFLib Python Library Reference

> Source: https://rdflib.dev/, https://rdflib.readthedocs.io/en/stable/gettingstarted/, https://rdflib.readthedocs.io/en/stable/intro_to_parsing/, https://rdflib.readthedocs.io/en/stable/intro_to_creating_rdf/, https://rdflib.readthedocs.io/en/stable/intro_to_graphs/, https://rdflib.readthedocs.io/en/stable/intro_to_sparql/, https://rdflib.readthedocs.io/en/stable/namespaces_and_bindings/
> Created: 2026-08-24
> Updated: 2026-08-24

## Overview

RDFLib is a pure Python package for working with RDF. It provides parsers/serializers for RDF/XML, N3, NTriples, N-Quads, Turtle, TriX, Trig, JSON-LD, and HexTuples. It includes a Graph interface (backed by in-memory, persistent, or remote SPARQL stores), a SPARQL 1.1 implementation (Queries & Updates), and SPARQL results wrapping.

**Current version**: 7.6.0 (Feb 2026)
**Install**: `pip install rdflib`

---

## Core API

### Graph — Primary RDF Container

```python
from rdflib import Graph

g = Graph()
```

A Graph is an un-sorted set of 3-item tuples (`(subject, predicate, object)`). Supports Python `set` operations: `add()`, `remove()`, iteration, containment checks.

```python
# Parse from URL
g.parse("http://www.w3.org/People/Berners-Lee/card")

# Parse local file (format guessed from extension)
g.parse("demo.nt")

# Parse from string with explicit format
g.parse(data="<x:> a <c:> .", format="turtle")

# Serialize (default format: turtle)
ttl = g.serialize(format="turtle")
xml = g.serialize(format="xml")
g.serialize(destination="output.ttl")
```

**Supported serialization formats**:

| Format | Keyword | Notes |
|--------|---------|-------|
| Turtle | `turtle`, `ttl`, `turtle2` | Default as of rdflib 6.0.0; turtle2 = more spacing |
| RDF/XML | `xml`, `pretty-xml` | Was default before 6.0.0 |
| JSON-LD | `json-ld` | Variants for compact syntax |
| N-Triples | `ntriples`, `nt`, `nt11` | nt11 = UTF-8 encoded |
| Notation-3 | `n3` | Superset of Turtle with rules |
| Trig | `trig` | Turtle-like for quads (triples + context) |
| TriX | `trix` | XML-like for quads |
| N-Quads | `nquads` | N-Triples-like for quads |

### RDF Term Types

```python
from rdflib import URIRef, BNode, Literal, Graph
from rdflib.namespace import FOAF, RDF, RDFS, OWL, XSD

# URIRef — known URI resource
bob = URIRef("http://example.org/people/Bob")

# BNode — blank node (GUID generated)
linda = BNode()

# Literal — data value
name = Literal("Bob")              # xsd:string
age = Literal(24)                  # xsd:integer (from Python int)
height = Literal(76.5)             # xsd:decimal (from Python float)
tagged = Literal("Bob", lang="en") # language-tagged string
typed = Literal("Bob", datatype=XSD.string)

# Namespace — URI factory
from rdflib import Namespace
EX = Namespace("http://example.org/")
EX.Person          # == URIRef("http://example.org/Person")
EX['first%20name'] # dict syntax for non-Python-identifiers
```

### Adding/Removing Triples

```python
g = Graph()
g.bind("foaf", FOAF)

# add() — insert a triple
g.add((bob, RDF.type, FOAF.Person))
g.add((bob, FOAF.name, Literal("Bob")))
g.add((bob, FOAF.knows, linda))

# set() — replaces existing values (like functional property)
g.set((bob, FOAF.age, Literal(43)))

# remove() — remove matching triples (None = wildcard)
g.remove((bob, None, None))  # remove all triples about bob
```

### Navigating Graphs

```python
# Iteration over all triples
for s, p, o in g:
    pass

# Contains check
if (bob, RDF.type, FOAF.Person) in g:
    print("Bob is a person")

# Triple pattern matching (None = wildcard)
for s, p, o in g.triples((None, RDF.type, FOAF.Person)):
    print(f"{s} is a person")

# Convenience methods
g.subjects(RDF.type, FOAF.Person)              # all subjects matching pattern
g.objects(bob, FOAF.knows)                      # all objects for (bob, knows)
g.predicates(subject=bob)                        # all predicates for subject
g.predicate_objects(bob)                         # all (pred, obj) for subject
g.subject_objects(predicate=FOAF.knows)           # all (subj, obj) for predicate

# value() — returns single value
name = g.value(bob, FOAF.name)                   # any single value
person = g.value(predicate=FOAF.knows, object=bob, any=False)  # raises if >1
```

### Set Operations on Graphs

```python
G1 = Graph()
G2 = Graph()

G1 + G2    # new graph with union
G1 += G2   # in-place union
G1 - G2    # new graph with difference (G1 triples not in G2)
G1 -= G2   # in-place difference
G1 & G2    # intersection
G1 ^ G2    # XOR (triples in either but not both)
```

**Warning**: Set operations assume blank nodes are shared between graphs.

### Dataset (Multi-graph / Quads)

```python
from rdflib import Dataset
from rdflib.namespace import RDF

ds = Dataset()
ds.parse("demo.trig")

for s, p, o, ctx in ds.quads((None, RDF.type, None, None)):
    print(s, ctx)
```

---

## Namespaces and Bindings

### Pre-defined Namespaces

```python
from rdflib.namespace import CSVW, DC, DCAT, DCTERMS, DOAP, FOAF, \
    ODRL2, ORG, OWL, PROF, PROV, RDF, RDFS, SDO, SH, SKOS, \
    SOSA, SSN, TIME, VOID, XMLNS, XSD

FOAF.knows   # URI for foaf:knows
RDF.type     # URI for rdf:type
OWL.Class    # URI for owl:Class
```

### Binding Prefixes

```python
g = Graph()
g.bind("foaf", FOAF)        # bind namespace to prefix
g.bind("ex", EX)             # custom namespace

# Namespace binding strategies
g = Graph(bind_namespaces="rdflib")   # bind all Rdflib namespaces
g = Graph(bind_namespaces="core")     # bind only core (owl, rdf, rdfs, xsd, xml)
g = Graph(bind_namespaces="none")     # no automatic bindings
```

### QName Resolution

```python
# Decompose URI into (prefix, namespace, local)
g.compute_qname(URIRef("http://foo/bar#baz"))
# => ("ns2", URIRef("http://foo/bar#"), "baz")

# N3 representation with namespace manager
person = URIRef("http://xmlns.com/foaf/0.1/Person")
person.n3(g.namespace_manager)   # => "foaf:Person"
Literal(2).n3(NamespaceManager(Graph(), bind_namespaces="core"))
# => '"2"^^xsd:integer'
```

---

## SPARQL Queries and Updates

### SELECT Queries

```python
import rdflib

g = rdflib.Graph()
g.parse("http://danbri.org/foaf.rdf#")

q = """
PREFIX foaf: <http://xmlns.com/foaf/0.1/>
SELECT DISTINCT ?aname ?bname
WHERE {
    ?a foaf:knows ?b .
    ?a foaf:name ?aname .
    ?b foaf:name ?bname .
}"""

for row in g.query(q):
    print(row.aname, "knows", row.bname)
    # Access by: row.aname, row["aname"], row[0]
```

### CONSTRUCT / DESCRIBE / ASK

```python
# CONSTRUCT returns triples
for triple in g.query("CONSTRUCT { ?s a ?o } WHERE { ?s a ?o }"):
    print(triple)

# ASK returns boolean
if bool(g.query("ASK { ?s a ?o }")):
    print("Found")
```

### UPDATE Queries (INSERT/DELETE)

```python
from rdflib import Graph

g = Graph()
g.parse(data="<x:> a <c:> .", format="turtle")

# INSERT
g.update("INSERT DATA { <z:> a <c:> }")

# DELETE/INSERT combination
g.update("""
    DELETE { <y:> a <c:> }
    INSERT { <y:> a <d:> }
    WHERE  { <y:> a <c:> }
""")
```

### Namespaces in SPARQL

```python
from rdflib.namespace import FOAF

# Pass initNs to expand prefixes in query
g.query('SELECT * WHERE { ?p a foaf:Person }', initNs={'foaf': FOAF})

# Or use graph's namespace manager (preferred)
qres = g.query(knows_query)
```

### Remote SPARQL Endpoint (SERVICE)

```python
g = rdflib.Graph()
qres = g.query("""
    SELECT ?s WHERE {
        SERVICE <https://dbpedia.org/sparql> {
            ?s a ?o .
        }
    }
    LIMIT 3
""")
```

### Prepared Queries

```python
from rdflib import prepareQuery

q = prepareQuery(
    "SELECT ?s WHERE { ?person foaf:knows ?s .}",
    initNs={"foaf": FOAF}
)

tim = URIRef("http://www.w3.org/People/Berners-Lee/card#i")
for row in g.query(q, initBindings={"person": tim}):
    print(row.s)
```

---

## Creating OWL Ontologies with RDFLib

```python
from rdflib import Graph, URIRef, Literal, BNode, Namespace
from rdflib.namespace import OWL, RDF, RDFS, XSD

# Create namespace for the ontology
EX = Namespace("http://example.org/families/")

g = Graph()
g.bind("ex", EX)
g.bind("owl", OWL)
g.bind("rdfs", RDFS)
g.bind("xsd", XSD)

# Ontology declaration
g.add((EX[""], RDF.type, OWL.Ontology))

# Class declarations
g.add((EX.Person, RDF.type, OWL.Class))
g.add((EX.Woman, RDF.type, OWL.Class))
g.add((EX.Man, RDF.type, OWL.Class))

# Subclass
g.add((EX.Woman, RDFS.subClassOf, EX.Person))
g.add((EX.Man, RDFS.subClassOf, EX.Person))

# Disjoint classes
bnode = BNode()
g.add((bnode, RDF.type, OWL.AllDisjointClasses))
g.add((bnode, OWL.members, BNode()))  # use Collection for list

# Object property declaration
g.add((EX.hasSpouse, RDF.type, OWL.SymmetricProperty))
g.add((EX.hasWife, RDF.type, OWL.ObjectProperty))
g.add((EX.hasWife, RDFS.subPropertyOf, EX.hasSpouse))
g.add((EX.hasWife, RDFS.domain, EX.Man))
g.add((EX.hasWife, RDFS.range, EX.Woman))

# Datatype property
g.add((EX.hasAge, RDF.type, OWL.DatatypeProperty))
g.add((EX.hasAge, RDFS.domain, EX.Person))
g.add((EX.hasAge, RDFS.range, XSD.nonNegativeInteger))

# Individuals
g.add((EX.Mary, RDF.type, OWL.NamedIndividual))
g.add((EX.Mary, RDF.type, EX.Person))
g.add((EX.Mary, RDF.type, EX.Woman))

# Property assertion
g.add((EX.John, EX.hasWife, EX.Mary))

# Data assertion
g.add((EX.John, EX.hasAge, Literal(51)))

# Annotation
g.add((EX.Person, RDFS.comment, Literal("Represents the set of all people.")))

print(g.serialize(format="turtle"))
```

---

## Plugin System

RDFLib uses a plugin architecture for extensibility:

| Plugin Type | Description | Examples |
|-------------|-------------|----------|
| **Stores** | Backend graph storage | In-memory (default), SQLAlchemy, HDT, ZODB, LevelDB, Neo4J |
| **Parsers** | Read RDF formats | Built-in: RDF/XML, Turtle, JSON-LD, N-Triples, N-Quads, TriG, TriX |
| **Serializers** | Write RDF formats | Same formats as parsers |
| **SPARQL** | Query evaluation | Built-in SPARQL 1.1 engine |

External packages extend RDFLib:
- `rdflib-sqlalchemy` — SQLAlchemy-backed Store
- `rdflib-hdt` — HDT document Store
- `rdflib-zodb` — ZODB-backed Store
- `rdflib-leveldb` — LevelDB Store
- `OWL-RL` — OWL 2 RL Profile reasoner
- `pySHACL` — SHACL validation
- `pyLODE` — OWL ontology documentation

---

## Configuration

### Installation

```bash
pip install rdflib
pip install git+https://github.com/RDFLib/rdflib.git@main#egg=rdflib
```

### Python Support

RDFLib 7.x supports Python 3.12–3.14, with testing on these versions.

### Common Serialize Options

```python
g.serialize(format="turtle")           # default, compact
g.serialize(format="turtle2")          # more spacing/linebreaks
g.serialize(format="pretty-xml")       # RDF/XML with indentation
g.serialize(format="json-ld")          # JSON-LD compacted
g.serialize(format="nquads")           # N-Quads (quads, not triples)
```

---

## Best Practices

1. **Use Namespace shortcuts** — Prefer `FOAF.Person` over `URIRef("http://xmlns.com/foaf/0.1/Person")`.
2. **Bind prefixes before serializing** — `g.bind("foaf", FOAF)` produces readable Turtle output.
3. **Close graphs with large data** — Use `with` context or call `g.close()` when done with persistent stores.
4. **Use `set()` for functional properties** — `g.set()` replaces all values for a (subject, property) pair.
5. **Prefer `value()` for single-valued lookups** — Instead of `.objects()` + `next()`.
6. **Use `initBindings` for prepared queries** — Avoids string concatenation in SPARQL queries.
7. **Use `Dataset` for multi-graph (quads)** — Regular `Graph` only works with triples.
8. **Handle BNode identity carefully** — Blank nodes from different graphs may not be equal even if structurally identical.
9. **Use `g.triples()` for partial matches** — More efficient than iterating all triples.
10. **Validate with `len(g)` after parsing** — Quick check that parsing succeeded.

---

## Common Pitfalls

- **Blank nodes don't merge** — `G1 + G2` does not merge blank nodes with same label across graphs.
- **Namespace collision** — Re-binding a prefix with `override=False` silently ignores the new binding.
- **`remove()` with None wildcards** — `g.remove((s, None, None))` removes ALL triples with that subject.
- **Parsing errors** — `parse()` raises `ParseError` on malformed input; catch if file format may vary.
- **Literal type mismatch** — `Literal(24)` creates `xsd:integer`, but `Literal("24")` creates `xsd:string`. Use `datatype=XSD.integer` for explicit typing.
- **RDF/XML required for OWL interop** — Some OWL reasoners only accept RDF/XML, not Turtle.
- **Large graphs in memory** — Default store is in-memory; use persistent stores (SQLAlchemy, HDT) for large datasets.

---

## Version Notes

| Release | Date | Key Changes |
|---------|------|-------------|
| **7.6.0** | Feb 2026 | Clients for RDF4J & GraphDB APIs |
| **7.4.0** | Oct 2025 | Python 3.12–3.14 support; MKDocs documentation |
| **7.3.0** | Oct 2025 | Dataset fixes, v8 deprecation notices |
| **7.1.3** | Jan 2025 | Deterministic serialisation, improved type hints |
| **7.0.0** | Aug 2023 | Major release: breaking changes, new features |
| **6.0.0** | Jul 2021 | Default serialization changed to Turtle |
| **5.0.0** | Apr 2020 | First major update in years, ClosedNamespace for FOAF |