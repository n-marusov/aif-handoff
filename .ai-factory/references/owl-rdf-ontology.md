# OWL/RDF/Turtle Ontology Creation Reference

> Source: W3C OWL 2 Overview (https://www.w3.org/TR/owl2-overview/), W3C OWL 2 Primer (https://www.w3.org/TR/owl2-primer/), W3C Turtle Spec (https://www.w3.org/TR/turtle/)
> Created: 2026-08-24
> Updated: 2026-08-24

## Overview

The **OWL 2 Web Ontology Language** is a Semantic Web language for representing rich and complex knowledge about things, groups of things, and relations between things. OWL 2 ontologies provide **classes** (sets of individuals), **properties** (relations), **individuals** (objects), and **data values**, stored as Semantic Web documents. OWL ontologies are primarily exchanged as RDF documents, most commonly serialized in **RDF/XML** (mandatory), **Turtle**, **Manchester Syntax**, or **OWL/XML**.

**RDF (Resource Description Framework)** is a general-purpose language for representing information in the Web. An RDF graph is a set of **triples** (subject-predicate-object). **Turtle (Terse RDF Triple Language)** is a compact textual syntax for RDF that is easy to read and write.

**Key distinction**: RDF is the data model foundation; OWL 2 builds on top of RDF to add formal semantics for ontologies—class hierarchies, property restrictions, cardinalities, disjointness, etc.

---

## Core Concepts

### RDF Triples

An RDF graph consists of triples in the form: **subject — predicate — object**. Subjects and predicates are IRIs or blank nodes; objects can be IRIs, blank nodes, or literals.

```turtle
<http://example.org/#spiderman> <http://xmlns.com/foaf/0.1/name> "Spiderman" .
```

### Turtle Language Elements

| Element | Syntax | Description |
|---------|--------|-------------|
| **Absolute IRI** | `<http://example.org/resource>` | Full IRI in angle brackets |
| **Relative IRI** | `<#green-goblin>` | Resolved against `@base` |
| **Prefixed name** | `foaf:Person` | Expanded via `@prefix` declaration |
| **`@base` directive** | `@base <http://example.org/> .` | Sets base IRI for relative IRIs |
| **`@prefix` directive** | `@prefix foaf: <http://xmlns.com/foaf/0.1/> .` | Binds prefix label to namespace IRI |
| **`PREFIX` (SPARQL-style)** | `PREFIX foaf: <http://xmlns.com/foaf/0.1/>` | Case-insensitive, no trailing `.` |
| **`BASE` (SPARQL-style)** | `BASE <http://example.org/>` | Case-insensitive, no trailing `.` |
| **Empty prefix** | `@prefix : <http://example.org/> .` | Binds default namespace |
| **`a` token** | `:spiderman a foaf:Person .` | Shorthand for `rdf:type` |
| **`;` (predicate list)** | `:s :p1 :o1 ; :p2 :o2 .` | Repeats subject for next predicate |
| **`,` (object list)** | `:s :p "o1", "o2" .` | Repeats subject+predicate for next object |
| **`[]` (blank node)** | `[ foaf:name "Bob" ]` | Anonymous blank node with properties |
| **`_:label` (blank node)** | `_:alice foaf:knows _:bob .` | Labeled blank node |
| **`()` (collection)** | `( :a :b :c )` | RDF list (rdf:first/rdf:rest) |
| **`#` comment** | `# this is a comment` | To end of line |

### OWL 2 Entities

| Entity Type | Purpose | Turtle Example |
|-------------|---------|----------------|
| **Class** | Sets of individuals | `:Woman rdf:type owl:Class .` |
| **Object Property** | Relations between individuals | `:hasWife rdf:type owl:ObjectProperty .` |
| **Datatype Property** | Relations from individuals to data values | `:hasAge rdf:type owl:DatatypeProperty .` |
| **Named Individual** | Concrete objects in the domain | `:John rdf:type owl:NamedIndividual .` |
| **Annotation Property** | Metadata about the ontology itself | `rdfs:comment`, `rdfs:label` |
| **Datatype** | Data value types | `xsd:integer`, `xsd:string` |

---

## OWL 2 Axioms — Core Patterns (Turtle)

### Class Declarations & Hierarchies

```turtle
@prefix : <http://example.com/owl/families/> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

# Class declaration
:Person rdf:type owl:Class .

# Subclass (every Woman is a Person)
:Woman rdfs:subClassOf :Person .

# Equivalent classes (Person = Human)
:Person owl:equivalentClass :Human .

# Disjoint classes (Woman and Man are disjoint)
[] rdf:type owl:AllDisjointClasses ;
   owl:members ( :Woman :Man ) .
```

### Property Declarations & Characteristics

```turtle
# Subproperty (hasWife is a subproperty of hasSpouse)
:hasWife rdfs:subPropertyOf :hasSpouse .

# Domain and Range
:hasWife rdfs:domain :Man ;
         rdfs:range :Woman .

# Inverse property (hasParent is inverse of hasChild)
:hasParent owl:inverseOf :hasChild .

# Property characteristics
:hasSpouse rdf:type owl:SymmetricProperty .         # if A hasSpouse B then B hasSpouse A
:hasChild  rdf:type owl:AsymmetricProperty .        # if A hasChild B then NOT B hasChild A
:hasAncestor rdf:type owl:TransitiveProperty .      # if A ancestorOf B and B ancestorOf C then A ancestorOf C
:hasRelative rdf:type owl:ReflexiveProperty .       # everything relates to itself
:parentOf rdf:type owl:IrreflexiveProperty .        # nothing relates to itself
:hasHusband rdf:type owl:FunctionalProperty .       # at most one value per subject
:hasHusband rdf:type owl:InverseFunctionalProperty . # at most one subject per value

# Property disjointness
:hasParent owl:propertyDisjointWith :hasSpouse .

# Property chains (hasGrandparent = hasParent o hasParent)
:hasGrandparent owl:propertyChainAxiom ( :hasParent :hasParent ) .
```

### Class Axioms with Complex Expressions

```turtle
# Intersection (Mother = Woman AND Parent)
:Mother owl:equivalentClass [
    rdf:type owl:Class ;
    owl:intersectionOf ( :Woman :Parent )
] .

# Union (Parent = Mother OR Father)
:Parent owl:equivalentClass [
    rdf:type owl:Class ;
    owl:unionOf ( :Mother :Father )
] .

# Complement (ChildlessPerson = Person AND NOT Parent)
:ChildlessPerson owl:equivalentClass [
    rdf:type owl:Class ;
    owl:intersectionOf ( :Person [ rdf:type owl:Class ; owl:complementOf :Parent ] )
] .

# Existential restriction (Parent = hasChild some Person)
:Parent owl:equivalentClass [
    rdf:type owl:Restriction ;
    owl:onProperty :hasChild ;
    owl:someValuesFrom :Person
] .

# Universal restriction (HappyPerson = hasChild only HappyPerson)
:HappyPerson owl:equivalentClass [
    rdf:type owl:Restriction ;
    owl:onProperty :hasChild ;
    owl:allValuesFrom :HappyPerson
] .

# hasValue restriction (JohnsChildren = hasParent value John)
:JohnsChildren owl:equivalentClass [
    rdf:type owl:Restriction ;
    owl:onProperty :hasParent ;
    owl:hasValue :John
] .

# Self restriction (NarcisticPerson = loves Self)
:NarcisticPerson owl:equivalentClass [
    rdf:type owl:Restriction ;
    owl:onProperty :loves ;
    owl:hasSelf "true"^^xsd:boolean
] .

# Cardinality (John has exactly 5 children)
:John rdf:type [
    rdf:type owl:Restriction ;
    owl:cardinality "5"^^xsd:nonNegativeInteger ;
    owl:onProperty :hasChild
] .

# Qualified cardinality (John has at least 2 children who are Parents)
:John rdf:type [
    rdf:type owl:Restriction ;
    owl:minQualifiedCardinality "2"^^xsd:nonNegativeInteger ;
    owl:onProperty :hasChild ;
    owl:onClass :Parent
] .

# Enumeration class (MyBirthdayGuests = {Bill, John, Mary})
:MyBirthdayGuests owl:equivalentClass [
    rdf:type owl:Class ;
    owl:oneOf ( :Bill :John :Mary )
] .
```

### Individual Assertions

```turtle
# Class membership
:Mary rdf:type :Person , :Woman .

# Property assertion (John hasWife Mary)
:John :hasWife :Mary .

# Data property assertion (John hasAge 51)
:John :hasAge 51 .

# Negative property assertion (Bill NOT hasWife Mary)
[] rdf:type owl:NegativePropertyAssertion ;
   owl:sourceIndividual :Bill ;
   owl:assertionProperty :hasWife ;
   owl:targetIndividual :Mary .

# Same individual (James = Jim)
:James owl:sameAs :Jim .

# Different individuals (John ≠ Bill)
:John owl:differentFrom :Bill .

# Keys (Person is identified by hasSSN)
:Person owl:hasKey ( :hasSSN ) .
```

---

## OWL 2 Profiles (Sublanguages)

| Profile | Acronym | Best For | Key Restrictions |
|---------|---------|----------|------------------|
| **OWL 2 EL** | EL (Existential Language) | Large bio-health ontologies (SNOMED-CT, NCI) | No universal quantification, no inverse properties |
| **OWL 2 QL** | QL (Query Language) | Database integration, query rewriting | No property chains, no existential to class expressions |
| **OWL 2 RL** | RL (Rule Language) | Rule-based reasoning on RDF data | No existential guarantees (every person has a parent) |

---

## Standard Prefixes (Common Namespaces)

| Prefix | Namespace IRI | Usage |
|--------|---------------|-------|
| `rdf:` | `http://www.w3.org/1999/02/22-rdf-syntax-ns#` | Core RDF (type, property, etc.) |
| `rdfs:` | `http://www.w3.org/2000/01/rdf-schema#` | RDF Schema (class, subClassOf, domain, range) |
| `owl:` | `http://www.w3.org/2002/07/owl#` | OWL ontology |
| `xsd:` | `http://www.w3.org/2001/XMLSchema#` | XML Schema datatypes |
| `foaf:` | `http://xmlns.com/foaf/0.1/` | Friend of a Friend vocabulary |
| `skos:` | `http://www.w3.org/2004/02/skos/core#` | Simple Knowledge Organization System |
| `dc:` | `http://purl.org/dc/elements/1.1/` | Dublin Core |
| `dcterms:` | `http://purl.org/dc/terms/` | Dublin Core Terms |
| `prov:` | `http://www.w3.org/ns/prov#` | Provenance |
| `sdo:` | `https://schema.org/` | Schema.org |
| `sh:` | `http://www.w3.org/ns/shacl#` | SHACL |

---

## Ontology Management

```turtle
# Ontology declaration
<http://example.com/owl/families> rdf:type owl:Ontology ;
    owl:imports <http://example.org/otherOntologies/families.owl> .

# Annotations
:Person rdfs:comment "Represents the set of all people."^^xsd:string .

# Annotated axiom
:Man rdfs:subClassOf :Person .
[] rdf:type owl:Axiom ;
   owl:annotatedSource :Man ;
   owl:annotatedProperty rdfs:subClassOf ;
   owl:annotatedTarget :Person ;
   rdfs:comment "States that every man is a person."^^xsd:string .
```

---

## Datatype Restrictions

```turtle
# Custom datatype (personAge = integer[0..150])
:personAge owl:equivalentClass [
    rdf:type rdfs:Datatype ;
    owl:onDatatype xsd:integer ;
    owl:withRestrictions (
        [ xsd:minInclusive "0"^^xsd:integer ]
        [ xsd:maxInclusive "150"^^xsd:integer ]
    )
] .

# Datatype intersection
:majorAge owl:equivalentClass [
    rdf:type rdfs:Datatype ;
    owl:intersectionOf ( :personAge
        [ rdf:type rdfs:Datatype ; owl:datatypeComplementOf :minorAge ] )
] .

# Datatype enumeration
:toddlerAge owl:equivalentClass [
    rdf:type rdfs:Datatype ;
    owl:oneOf ( "1"^^xsd:integer "2"^^xsd:integer )
] .
```

---

## Configuration

### Turtle File Format

| Property | Value |
|----------|-------|
| **Media type** | `text/turtle` |
| **File extension** | `.ttl` |
| **Encoding** | UTF-8 |
| **Identified by IRI** | `http://www.w3.org/ns/formats/Turtle` |
| **Charset** | Always UTF-8 |

### OWL 2 Syntax Options

| Syntax | Status | Best Use Case |
|--------|--------|---------------|
| **RDF/XML** | Mandatory for all OWL 2 tools | Interoperability |
| **Turtle** | Optional | Human readability, editing |
| **Manchester Syntax** | Optional (WG Note) | Non-logician readability |
| **OWL/XML** | Optional | XML toolchain integration |
| **Functional-Style Syntax** | Optional (in spec) | Specification, API implementation |

---

## Best Practices

1. **Use explicit declarations** — Always declare classes, properties, and individuals with `rdf:type` statements before using them.
2. **Define prefix namespaces** — Use `@prefix` at the top of Turtle files for readability and IRI management.
3. **Model with subclass/disjointness** — Without explicit disjointness, classes are assumed potentially overlapping unless stated otherwise.
4. **Avoid domain/range overreach** — Domain and range axioms allow *inference*, not *constraint enforcement*. They can lead to unexpected inferences (e.g., anything with an age becomes a Person).
5. **Use property characteristics carefully** — `Transitive`, `Symmetric`, `Functional` affect reasoning significantly.
6. **Prefer existential (`some`) over universal (`only`)** — `some` is more intuitive and commonly needed; `only` (universal) is vacuously true for individuals without any values of that property.
7. **Declare owl:imports sparingly** — Each import loads the entire referenced ontology; circular imports cause issues.
8. **Annotate with rdfs:comment and rdfs:label** — Document class/property meanings for human readers.
9. **Use Qualified Cardinality** — Prefer `owl:qualifiedCardinality` over `owl:cardinality` when the class of values matters.
10. **Validate with reasoners** — Use reasoners (e.g., HermiT, Pellet, ELK) to detect inconsistencies before deployment.

---

## Common Pitfalls

- **Universal quantification vacuously true** — `hasChild only HappyPerson` is true for anyone with zero children. Combine with existential (`some`) when you mean "at least one".
- **Domain/range generate unintended inferences** — `rdfs:domain :Person` on `:hasAge` means ANY individual with an age is inferred to be a Person.
- **Missing unique name assumption** — OWL does NOT assume different IRIs refer to different entities. Use `owl:differentFrom` explicitly.
- **Forgetting disjointness** — Without `owl:AllDisjointClasses`, classes are not disjoint by default.
- **Property chain direction** — `owl:propertyChainAxiom ( :hasParent :hasParent )` defines `:hasGrandparent` but does NOT automatically make `:hasParent` a subproperty of `:hasGrandparent`.
- **Profile restrictions** — OWL 2 DL constructs like universal quantification may not work in OWL 2 EL/QL/RL profiles.

---

## Version Notes

- **RDF 1.1 Turtle** — W3C Recommendation 25 February 2014. Added `PREFIX`/`BASE` (case-insensitive) from SPARQL.
- **OWL 2 (Second Edition)** — W3C Recommendation 11 December 2012. Backward compatible with OWL 1.
- **OWL 2 new features** vs OWL 1: keys, property chains, richer datatypes, qualified cardinality, asymmetric/reflexive/disjoint properties, enhanced annotations, punning.
- **Punning** in OWL 2 DL allows using the same IRI as both a class and an individual (e.g., `:Father` as both a class and an individual of type `:SocialRole`).