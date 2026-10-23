package io.ctxo.jdt;

import java.util.*;

/**
 * The Java rows of the shared known-API table (spec 8A.2) as data: the members whose SQL text is
 * an argument, and the method annotations whose {@code value} is SQL text. {@link SqlCallSites}
 * does the matching. ORM queries (JPQL, Spring Data derived queries) stay out.
 */
final class KnownSqlApis {
  private KnownSqlApis() {}

  /** Members of one or more owner types; the SQL text is the first argument. */
  static final class CallApi {
    /** Fully qualified owner types; a receiver or declaring type matches through any supertype. */
    final Set<String> owners;
    final Set<String> members;
    /** Every member whose name starts with this prefix also matches; null for none. */
    final String memberPrefix;

    CallApi(Set<String> owners, Set<String> members, String memberPrefix) {
      this.owners = owners; this.members = members; this.memberPrefix = memberPrefix;
    }

    boolean hasMember(String name) {
      return members.contains(name) || (memberPrefix != null && name.startsWith(memberPrefix));
    }
  }

  /** A method annotation whose {@code value} is SQL text; array elements are joined with one space. */
  static final class AnnotationApi {
    final String type;
    /** True when the text counts only with {@code nativeQuery = true} (Spring Data JPA; JPQL otherwise). */
    final boolean nativeQueryOnly;

    AnnotationApi(String type, boolean nativeQueryOnly) {
      this.type = type; this.nativeQueryOnly = nativeQueryOnly;
    }
  }

  static final List<CallApi> CALLS = List.of(
      new CallApi(Set.of("java.sql.Connection"), Set.of("prepareStatement", "prepareCall"), null),
      new CallApi(Set.of("java.sql.Statement"), Set.of(), "execute"),
      new CallApi(
          Set.of(
              "org.springframework.jdbc.core.JdbcTemplate",
              "org.springframework.jdbc.core.JdbcOperations",
              "org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate",
              "org.springframework.jdbc.core.namedparam.NamedParameterJdbcOperations"),
          Set.of("query", "queryForObject", "queryForList", "queryForMap", "queryForRowSet", "queryForStream",
              "update", "batchUpdate", "execute"),
          null),
      new CallApi(Set.of("javax.persistence.EntityManager", "jakarta.persistence.EntityManager"),
          Set.of("createNativeQuery"), null));

  /** The member whose every argument is SQL text when all of them are Strings ({@code batchUpdate(String...)}). */
  static final String ALL_STRING_ARGUMENTS = "batchUpdate";

  static final List<AnnotationApi> ANNOTATIONS = List.of(
      new AnnotationApi("org.springframework.data.jpa.repository.Query", true),
      new AnnotationApi("org.apache.ibatis.annotations.Select", false),
      new AnnotationApi("org.apache.ibatis.annotations.Insert", false),
      new AnnotationApi("org.apache.ibatis.annotations.Update", false),
      new AnnotationApi("org.apache.ibatis.annotations.Delete", false));

  private static final Set<String> ANNOTATION_SIMPLE_NAMES = simpleNames();

  private static Set<String> simpleNames() {
    Set<String> names = new HashSet<>();
    for (AnnotationApi api : ANNOTATIONS) names.add(api.type.substring(api.type.lastIndexOf('.') + 1));
    return names;
  }

  /** True when some row lists the member; a cheap filter before any binding is resolved. */
  static boolean anyCallMember(String member) {
    for (CallApi api : CALLS) if (api.hasMember(member)) return true;
    return false;
  }

  /** The row listing the member for one of the owner types; null when none does. */
  static CallApi findCall(String member, Set<String> ownerTypes) {
    for (CallApi api : CALLS) {
      if (!api.hasMember(member)) continue;
      for (String owner : api.owners) if (ownerTypes.contains(owner)) return api;
    }
    return null;
  }

  /** True when some row's annotation has this simple name; a cheap filter before resolving the type. */
  static boolean anyAnnotation(String simpleName) {
    return ANNOTATION_SIMPLE_NAMES.contains(simpleName);
  }

  /** The row of a fully qualified annotation type; null when none. */
  static AnnotationApi findAnnotation(String qualifiedName) {
    for (AnnotationApi api : ANNOTATIONS) if (api.type.equals(qualifiedName)) return api;
    return null;
  }
}
