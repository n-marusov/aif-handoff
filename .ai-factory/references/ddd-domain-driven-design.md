# Domain-Driven Design (DDD) Reference

> Source: Eric Evans, «Domain-Driven Design: Tackling Complexity in the Heart of Software» (Blue Book); Vaughn Vernon, «Implementing Domain-Driven Design» (Red Book); microarch.ru; sky.pro; tproger.ru; habr.com
> Created: 2026-08-24
> Updated: 2026-08-24

## Overview

Domain-Driven Design (DDD) is an approach to software development where the architecture is built around a deep understanding and modeling of the subject domain (domain). It was first detailed by Eric Evans in his book «Domain-Driven Design» (the «Blue Book»), and later Vaughn Vernon contributed significantly to practical implementation in «Implementing Domain-Driven Design» (the «Red Book»).

The core idea: the complexity of modern systems often lies in understanding and correctly modeling the domain, not in technical details. Therefore, project success depends directly on close collaboration between developers and domain experts.

DDD is not a technology or framework, but a set of principles and tactical patterns that help make correct design decisions. It is especially effective for systems with complex business logic where technical solutions must closely align with real business needs. For simple CRUD applications, DDD may be overkill.

## Core Concepts

### Ubiquitous Language

A shared language used by all project participants — from analysts to developers — that permeates code, documentation, and discussions. Every term has a single, unambiguous meaning within its context. This eliminates translation loss between business and technical teams and ensures the code speaks the same language as the domain experts.

- Must be used consistently in code (class names, method names, variable names), documentation, user stories, and verbal discussions
- Evolves as the team's understanding of the domain deepens
- Disagreements about terminology often reveal misunderstandings about the domain itself

### Domain Model

An abstraction that embodies knowledge about the domain in code. It reflects key entities, rules, and relationships of the real world. The model is not a copy of reality, but a purposeful simplification that is useful for solving a specific problem.

- The model must be rich enough to express business rules and invariants
- Must be expressed in executable code, not just in diagrams or documents
- Drives design decisions at every level

### Bounded Context

A clear boundary within which a consistent model and a unified ubiquitous language apply. The same term can have different meanings in different contexts.

**Example:** In the «Catalog» context, `Product` is a product card with descriptions, images, and attributes. In the «Order Processing» context, `Product` is a line item with quantity and price. These are different models for the same real-world concept.

- Each bounded context has its own ubiquitous language
- Each bounded context has its own domain model, which may overlap with others
- Boundaries are often aligned with organizational boundaries (Conway's Law)
- Communication between contexts is handled via Context Mapping

### Strategic Design vs. Tactical Design

**Strategic Design** manages complexity at a high level:
- Identifies subdomains (Core, Supporting, Generic)
- Defines Bounded Contexts and their relationships
- Produces a Context Map showing how contexts interact

**Tactical Design** provides building blocks for code inside a Bounded Context:
- Entities, Value Objects, Aggregates
- Domain Events, Services, Repositories, Factories

## Subdomains (Strategic)

| Type | Description | Strategy |
|------|-------------|----------|
| **Core Domain** | The most important subdomain — where the business differentiates itself from competitors. Most complex and valuable. | Invest the best talent. Build in-house. Evolve carefully. |
| **Supporting Subdomain** | Necessary for the business but not a competitive advantage. Complex, but not core. | Can be built in-house or outsourced. Needed, but not differentiating. |
| **Generic Subdomain** | Not core, not unique. Well-understood problems with existing solutions. | Buy off-the-shelf or use open-source. E.g., authentication, logging, billing. |

## Context Mapping (Strategic)

Patterns for describing relationships between Bounded Contexts:

| Pattern | Description | Direction |
|---------|-------------|-----------|
| **Partnership** | Two contexts collaborate; changes are coordinated | Two-way |
| **Shared Kernel** | Shared subset of model; changes require team coordination | Two-way |
| **Customer-Supplier** | Upstream (supplier) provides model; downstream (customer) adapts | One-way (upstream) |
| **Conformist** | Downstream blindly conforms to upstream model (no influence) | One-way |
| **Anticorruption Layer** | Downstream translates upstream model to its own model | One-way (protective) |
| **Open Host Service** | Upstream exposes a stable protocol/service | One-way |
| **Published Language** | Shared interchange format or protocol | One-way |
| **Separate Ways** | No integration; completely separate implementations | None |
| **Big Ball of Mud** | No clear boundaries; everything is entangled (anti-pattern) | N/A |

## Tactical Design Building Blocks

### Entities

Objects with a unique identity and a lifecycle. Two entities are equal if their IDs match, even if other attributes differ.

- Identity may be natural (SSN, email) or artificial (UUID, auto-increment)
- State changes over time; the identity remains constant
- Examples: `Order`, `Customer`, `Product` (in a specific context)

```java
public class Order {
    private OrderId id;
    private OrderStatus status;
    private Money total;
    
    public Order(OrderId id) {
        this.id = id;
        this.status = OrderStatus.PENDING;
    }
    
    public void confirm() {
        if (this.status != OrderStatus.PENDING) {
            throw new IllegalStateException("Only pending orders can be confirmed");
        }
        this.status = OrderStatus.CONFIRMED;
    }
    
    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (o == null || getClass() != o.getClass()) return false;
        Order order = (Order) o;
        return id.equals(order.id);
    }
}
```

### Value Objects

Immutable objects that describe properties but have no identity of their own. Two value objects are equal if all their attributes match.

- **Must be immutable** — never change state after creation
- Can be freely shared and copied
- Side-effect-free — methods return new instances
- Examples: `Address`, `Money`, `PhoneNumber`, `Email`, `Color`

```java
public final class Money {
    private final BigDecimal amount;
    private final Currency currency;
    
    public Money(BigDecimal amount, Currency currency) {
        this.amount = amount;
        this.currency = currency;
    }
    
    public Money add(Money other) {
        if (!this.currency.equals(other.currency)) {
            throw new IllegalArgumentException("Currency mismatch");
        }
        return new Money(this.amount.add(other.amount), this.currency);
    }
    
    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (o == null || getClass() != o.getClass()) return false;
        Money money = (Money) o;
        return amount.equals(money.amount) && currency.equals(money.currency);
    }
}
```

### Aggregates

A cluster of associated objects treated as a single unit for data changes. Each aggregate has a **root entity** (Aggregate Root) that is the only entry point for modifying the aggregate.

- **Invariant enforcement:** business rules that must always be consistent are enforced by the aggregate root
- **External references:** other objects can only hold references to the aggregate root, not to internal entities
- **Transaction boundary:** a single aggregate is modified in one transaction; modifying multiple aggregates should be done via eventual consistency
- **Rule of thumb:** prefer small aggregates (Vernon recommends 1 entity per aggregate when possible)

```java
public class Order extends AggregateRoot<OrderId> {
    private OrderId id;
    private List<OrderLine> lines;
    private OrderStatus status;
    
    public void addProduct(ProductId productId, Money price, int quantity) {
        if (status != OrderStatus.PENDING) {
            throw new IllegalStateException("Cannot modify a confirmed order");
        }
        lines.add(new OrderLine(productId, price, quantity));
        recalculateTotal();
    }
    
    private void recalculateTotal() {
        // invariant: total must always equal sum of line totals
        // this is enforced internally, never exposed for external modification
    }
}
```

### Domain Events

Something important that happened in the domain, captured as an object. Other parts of the system can react to it.

- Named in the past tense: `OrderConfirmed`, `PaymentReceived`, `StockDepleted`
- Immutable — once recorded, the event cannot change
- Can be published synchronously or asynchronously
- Enable loose coupling between aggregates and bounded contexts

```java
public class OrderConfirmed {
    private final OrderId orderId;
    private final Instant occurredOn;
    
    public OrderConfirmed(OrderId orderId) {
        this.orderId = orderId;
        this.occurredOn = Instant.now();
    }
    
    public OrderId getOrderId() { return orderId; }
    public Instant getOccurredOn() { return occurredOn; }
}
```

### Domain Services

Stateless operations that don't naturally belong to an Entity or Value Object. A service operates on multiple domain objects to produce a result.

- **Stateless** — no internal state, only behavior
- Named after the domain concept, not technical infrastructure: `TransferService`, `PricingService` (not `XmlParserService`)
- The operation is part of the ubiquitous language but doesn't fit naturally into an entity

```java
public class PricingService {
    public Money calculateDiscount(Order order, CustomerTier tier) {
        // business rule: tier-based discount calculation
        // doesn't naturally belong to Order or Customer alone
    }
}
```

### Repositories

An abstraction that provides access to persisted aggregates as if they were in memory. Each aggregate root typically has its own repository. The client uses the repository to retrieve and persist aggregates without knowing about the underlying storage.

- **One repository per aggregate root** — not per table or entity
- **Hides storage details** — the domain does not depend on ORM, SQL, NoSQL
- **Collection-oriented interface** — `find()`, `save()`, `delete()` (like an in-memory collection)
- Implemented in the infrastructure layer, defined in the domain layer

```java
public interface OrderRepository {
    Order findById(OrderId id);
    void save(Order order);
    void delete(OrderId id);
    List<Order> findByCustomerId(CustomerId customerId);
}
```

### Factories

Encapsulate the logic of creating complex objects and aggregates. When construction becomes complicated, a factory takes responsibility for it.

- Can be a separate class or a static factory method on the aggregate root
- Ensures the created object is in a valid state
- Hides construction details from the client

## Layered Architecture (Typical DDD Layering)

| Layer | Responsibility | Contains |
|-------|---------------|----------|
| **Presentation / UI** | User interaction, API contracts | Controllers, DTOs, ViewModels |
| **Application** | Orchestration, transaction coordination, security | Application Services, DTOs, mappers |
| **Domain** | Business logic, rules, state | Entities, Value Objects, Aggregates, Domain Events, Repositories (interfaces), Domain Services |
| **Infrastructure** | Technical concerns, persistence, messaging | Repository implementations, ORM, message buses, file systems |

**Dependency rule:** The Domain layer never depends on other layers. Infrastructure implements interfaces defined in Domain. Application uses Domain and Infrastructure.

## Best Practices

1. **Start with strategic design** — understand the domain landscape through Event Storming or similar techniques before writing code. Identify Core, Supporting, and Generic subdomains.
2. **Invest heavily in the Core Domain** — the most complex and differentiating part deserves the best design, talent, and refactoring budget.
3. **Keep Aggregates small** — large aggregates cause performance problems and transaction conflicts. Vaughn Vernon recommends 1 entity per aggregate as a starting point.
4. **Design Aggregates around consistency boundaries** — ask «what must be consistent in a single transaction?» If two objects can be eventually consistent, they should be separate aggregates.
5. **Prefer Value Objects** — they are immutable, side-effect-free, and easier to reason about. Any concept that has no identity should be a Value Object.
6. **Use Domain Events for cross-aggregate communication** — modifying multiple aggregates in one transaction is fragile. Publish events and handle them asynchronously.
7. **Make implicit concepts explicit** — if a business rule exists, name it. Don't hide it in an `if` statement. Create a specification, a policy, or a rule object.
8. **Evolve the ubiquitous language together** — if a business term is confusing, stop and clarify. The model should mirror the language, not the database schema.
9. **Test the domain model** — unit tests should express business rules in the ubiquitous language. Tests are executable specifications.
10. **Model boundaries with Context Mapping** — don't merge models just because they share terms. Identify the bounded contexts and define integration contracts.

## Common Pitfalls

1. **Anemic Domain Model** — entities and value objects with only getters/setters and no behavior. All logic lives in services. This is NOT DDD, this is data structures with a fancy name.
2. **Premature abstraction** — DDD tactical patterns (aggregates, repositories, domain events) add complexity. Don't apply them where CRUD suffices. Reserve DDD for the Core Domain.
3. **Infrastructure leak** — embedding SQL, HTTP calls, or framework annotations in domain entities. The domain layer should be pure, framework-agnostic code.
4. **Giant Aggregates** — modeling an entire aggregate as one root with hundreds of entities, causing serialization and locking bottlenecks. Break them down.
5. **Ignoring Strategic Design** — jumping straight to Entities and Repositories without identifying subdomains or bounded contexts. DDD without strategy leads to «Big Ball of Mud».
6. **Database-driven modeling** — building entities to match database tables instead of modeling the domain. This is the most common mistake when teams «try DDD».
7. **One model fits all** — using the same `User` or `Product` model across different contexts. Different contexts need different models, even if they refer to the same real-world concept.
8. **Forgetting the ubiquitous language** — the team speaks business terms but the code uses different names. This causes translation errors and makes the code incomprehensible to domain experts.

## Version Notes

No versioning applies to DDD itself. Key publications:

- **2003** — Eric Evans, «Domain-Driven Design: Tackling Complexity in the Heart of Software» (Blue Book). Foundational work.
- **2013** — Vaughn Vernon, «Implementing Domain-Driven Design» (Red Book). Practical implementation guidance, aggregate design rules.
- **2015** — Vaughn Vernon, «Domain-Driven Design Distilled». Concise overview.
- **2020s** — Growing adoption of DDD with microservices, Event Storming methodology (Alberto Brandolini), and CQRS/Event Sourcing patterns.

## Relationship to Other Patterns

| Pattern | Relationship to DDD |
|---------|-------------------|
| **CQRS** | Separates read and write models. Often paired with DDD: commands modify aggregates, queries bypass the domain model for performance. |
| **Event Sourcing** | Stores aggregate state as a sequence of events. Complements DDD by persisting Domain Events as the source of truth. |
| **Event Storming** | Collaborative workshop technique (by Alberto Brandolini) to discover domain events, bounded contexts, and aggregates. The go-to method for strategic DDD discovery. |
| **Hexagonal Architecture** | Also known as Ports & Adapters. Aligns with DDD's layered architecture: the domain is the core hexagon, infrastructure adapters plug into ports. |
| **Microservices** | Each microservice ideally maps to one Bounded Context. DDD provides the boundaries; microservices provide the deployment units. |